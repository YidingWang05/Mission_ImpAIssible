// 家电数字人老师 —— 服务端
//
// 输入（前端）：① 家电照片 ② 用户选的语言 ③ 用户对这台家电的疑问
//   · /api/analyze 只用 ① ②：识别品牌型号 → 联网查官网说明 / 论坛解答 → 输出“使用步骤 JSON 文件”
//   · ③ 交给数字人 Ava 在讲解时回答
//
// 接口：
//   POST /api/analyze        流式（NDJSON）返回进度 + 最终步骤 JSON；JSON 同时保存到 output/guides/<id>.json
//   GET  /guides/:id.json    下载步骤 JSON
//   POST /api/session-token  数字人会话令牌：phase=greet（打招呼）/ lesson（讲解，注入步骤 JSON + 客户端工具）
//   POST /api/translate      数字人自由回答的英文字幕
//   POST /api/ask            问答：tutorial_id 取上下文 → 红线检查 → 判断问题类型 → 简短回答 + 要播的范围
//   GET  /api/render/:id     步骤时间标记（C 的真实视频做好前，按讲解词长度估算）
import "dotenv/config";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { LANGUAGES } from "./languages.js";
import { keysFor, withKey, fetchWithKey, isKeyError } from "./keys.js";
import { PERSONA, greetPrompt, lessonPrompt, LESSON_TOOLS } from "./persona.js";
import { DEMO_GUIDE, DEMO_DANGER_GUIDE } from "./demo.js";
import { TriageSchema, TRIAGE_SYSTEM, blockedGuide, classifyDanger, dangerReply } from "./safety.js";
import { AskSchema, ASK_SYSTEM, catalog, chapters, normalizeAsk, heuristicAsk } from "./brain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUIDE_DIR = path.join(here, "output", "guides");
const MEDIA_DIR = path.join(here, "output", "media");
await fs.mkdir(GUIDE_DIR, { recursive: true });
await fs.mkdir(MEDIA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(here, "public")));
app.get("/vendor/anam.js", (_req, res) =>
  res.sendFile(path.join(here, "node_modules/@anam-ai/js-sdk/dist/umd/anam.js")),
);

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const ASK_MODEL = process.env.CLAUDE_ASK_MODEL || MODEL; // 问答用的模型，默认和识别相同
// 每个服务可以配多个密钥（NAME、NAME_2、NAME_3 …）：额度不足 / 鉴权失败时自动换下一个，见 keys.js
const CLAUDE_KEYS = keysFor("ANTHROPIC_API_KEY");
const HAS_CLAUDE = CLAUDE_KEYS.length > 0 || Boolean(process.env.ANTHROPIC_AUTH_TOKEN);
const HAS_ANAM = keysFor("ANAM_API_KEY").length > 0;

// Claude 客户端：每个密钥一个，按需创建。所有调用都经过 callClaude，所以换密钥对下面的代码是透明的。
const clients = new Map();
const clientFor = (key) => clients.get(key) || clients.set(key, new Anthropic({ apiKey: key })).get(key);
const callClaude = (fn) => (CLAUDE_KEYS.length ? withKey("ANTHROPIC_API_KEY", (key) => fn(clientFor(key))) : fn(new Anthropic()));
const claude = HAS_CLAUDE && {
  beta: {
    messages: {
      parse: (params) => callClaude((c) => c.beta.messages.parse(params)),
      create: (params) => callClaude((c) => c.beta.messages.create(params)),
      // 流式：换密钥重试时要把监听器重新挂到新的流上
      stream: (params) => {
        const listeners = [];
        return {
          on(event, cb) { listeners.push([event, cb]); return this; },
          finalMessage: () =>
            callClaude((c) => {
              const s = c.beta.messages.stream(params);
              for (const [event, cb] of listeners) s.on(event, cb);
              return s.finalMessage();
            }),
        };
      },
    },
  },
};
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const langOf = (code) => LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];

app.get("/api/config", (_req, res) => {
  res.json({
    persona: { name: PERSONA.name, image: PERSONA.image, avatarId: PERSONA.avatarId, voiceId: PERSONA.voiceId, llmId: PERSONA.llmId },
    languages: LANGUAGES.map(({ code, name, english, greeting, ui, rtl }) => ({ code, name, english, greeting, ui, rtl: !!rtl })),
    demo: { claude: !HAS_CLAUDE, avatar: !HAS_ANAM },
    // 数字人会话：Anam 每个会话有时长上限（Free 套餐 3 分钟）。前端按“段”续会话，说完就断开待机。
    session: {
      limitSeconds: Number(process.env.ANAM_SESSION_LIMIT_SECONDS ?? 180), // 0 = 不限制，不主动续会话
      idleSeconds: Number(process.env.ANAM_IDLE_SECONDS ?? 4),             // Ava 说完后多久没人接话就断开
      pauseEachSection: process.env.LESSON_PAUSE_EACH_SECTION === "1",      // 每讲完一段就停下等用户
    },
  });
});

// =====================================================================================
// 1. 识别 + 联网检索 + 生成步骤 JSON
// =====================================================================================

// 第一阶段：看照片认品牌型号，联网查官网说明书和论坛，写研究笔记
const RESEARCH_SYSTEM = `You are a home-appliance research assistant. You get a photo of an appliance's control panel.
1. Identify the appliance type, BRAND and exact MODEL. Read logos, model-number stickers and printed text carefully. If the model isn't visible, give the most likely series and say how sure you are.
2. Use web search to find (a) the manufacturer's official manual / support page for this model or series, and (b) forum or Q&A answers (Reddit, Kakaku, Zhihu, manufacturer communities, etc.) about operating it. Search in English and in the panel's language. Prefer the official manual; use forums for practical tips and common mistakes. Fetch the most useful page if a snippet is not enough.
3. Write concise research notes in English:
   - Appliance type, brand, model, confidence (high/medium/low) and why
   - Every control visible in the photo: printed label, translation, what it does (per the sources)
   - The standard operating procedure for the most common task, step by step, in panel order
   - Other common tasks the user is likely to need, briefly
   - Tips, common mistakes, safety warnings from the sources
   Mark which facts come from the official manual and which from forums. If nothing reliable is found, say so and rely on what the panel shows.`;

// 第二阶段：把照片 + 研究笔记整理成结构化步骤（含按钮在照片上的坐标）
const Box = z.object({
  x: z.number().describe("left, 0-1000 relative to image width"),
  y: z.number().describe("top, 0-1000 relative to image height"),
  w: z.number().describe("width, 0-1000"),
  h: z.number().describe("height, 0-1000"),
});
const Bi = z.object({ native: z.string(), en: z.string() });
const GuideSchema = z.object({
  recognized: z.boolean().describe("false if the photo doesn't show a readable appliance control panel"),
  appliance_native: z.string(),
  appliance_en: z.string(),
  brand: z.string().describe("brand, or 'unknown'"),
  model: z.string().describe("model number / series, or 'unknown'"),
  model_confidence: z.enum(["high", "medium", "low"]),
  goal_native: z.string().describe("the task these steps accomplish (most common use)"),
  goal_en: z.string(),
  intro_native: z.string().describe("1-2 spoken sentences: what this is (brand/model) and what we'll do"),
  intro_en: z.string(),
  buttons: z.array(
    z.object({
      id: z.string().describe("short id: b1, b2, …"),
      panel_text: z.string().describe("label as printed on the panel (original language) or icon description"),
      name_native: z.string(),
      name_en: z.string(),
      function_native: z.string(),
      function_en: z.string(),
      box: Box.describe("tight bounding box of the control in THIS photo"),
    }),
  ),
  steps: z.array(
    z.object({
      button_id: z.string().nullable().describe("button to press in this step, or null"),
      action_native: z.string().describe("short imperative, e.g. press the power button"),
      action_en: z.string(),
      narration_native: z.string().describe("2-3 spoken sentences; say where the control is (position/colour/label)"),
      narration_en: z.string(),
      source_ids: z.array(z.number().int()).describe("ids from the SOURCES list that support this step; [] if from the photo only"),
    }),
  ),
  tips: z.array(Bi).describe("practical tips from the manual / forums"),
  warnings: z.array(Bi).describe("safety warnings"),
  closing_native: z.string(),
  closing_en: z.string(),
});

const GUIDE_SYSTEM = `You turn appliance research notes into a lesson for a digital tutor.
Rules:
- Base steps on the research notes (official manual first, forums for tips). Where the notes and the photo disagree, trust what the photo shows.
- Only include controls that are visible in the photo, and give each a tight bounding box (0-1000 normalized to this photo).
- One action per step, in real operating order; teach the most common task.
- Narration is spoken by a friendly teacher: plain words, short sentences, no jargon.
- *_native / .native fields are in the user's native language; *_en / .en fields in English.
- Never write steps for repairs, opening the casing, gas supply, wiring, or bypassing safety locks. Put a warning instead that tells the user to contact the manufacturer's official support or their landlord.
- If the photo is not a readable control panel, set recognized=false and use intro_* to politely ask for a closer, straight-on, well-lit photo.`;

// NDJSON 流：前端可以实时显示“正在搜索 …”
app.post("/api/analyze", async (req, res) => {
  const { image, mediaType = "image/jpeg", lang: code, sample } = req.body || {}; // 注意：不接收用户疑问
  const lang = langOf(code);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const send = (obj) => res.write(JSON.stringify(obj) + "\n");

  try {
    if (!HAS_CLAUDE) {
      send({ type: "status", stage: "safety" });
      if (sample === "boiler") return await finish(send, res, { ...DEMO_DANGER_GUIDE(lang.code), demo: true }, lang);
      send({ type: "status", stage: "research" });
      send({ type: "search", query: "AQUA AW-7G 取扱説明書 (demo)" });
      return await finish(send, res, { ...DEMO_GUIDE(lang.code), demo: true }, lang);
    }
    if (!image) throw new Error("缺少照片");
    const imageBlock = { type: "image", source: { type: "base64", media_type: mediaType, data: image } };

    // ---- 阶段 0：安全红线（最先做，越线就不再检索、不生成教程）----
    send({ type: "status", stage: "safety" });
    const danger = await triage(imageBlock, lang);
    if (danger) return await finish(send, res, danger, lang);

    // ---- 阶段 1：识别 + 联网检索 ----
    send({ type: "status", stage: "research" });
    const { notes, sources } = await research(imageBlock, send);

    // ---- 阶段 2：结构化成步骤 JSON ----
    send({ type: "status", stage: "compose", sources: sources.length });
    const msg = await claude.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      ...FALLBACK,
      output_config: { effort: "medium", format: betaZodOutputFormat(GuideSchema) },
      system: GUIDE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            imageBlock,
            {
              type: "text",
              text:
                `User's native language: ${lang.english} (${lang.name}, ${lang.code}).\n\n` +
                `SOURCES:\n${sources.map((s) => `[${s.id}] ${s.title} — ${s.url}`).join("\n") || "(none found)"}\n\n` +
                `RESEARCH NOTES:\n${notes || "(no notes; rely on the photo)"}`,
            },
          ],
        },
      ],
    });
    if (msg.stop_reason === "refusal" || !msg.parsed_output) throw new Error("这张照片无法分析，请换一张试试");
    await finish(send, res, toGuideFile(msg.parsed_output, sources), lang);
  } catch (e) {
    console.error("analyze", e);
    send({ type: "error", error: e?.message || "识别失败，请稍后再试" });
    res.end();
  }
});

// 看照片判断设备本身是否越过红线。越线返回“被拦截的完整说明”，否则返回 null。
// 判断不了（模型拒答 / 没有结构化结果）时不放行。
async function triage(imageBlock, lang) {
  const msg = await claude.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    ...FALLBACK,
    output_config: { effort: "low", format: betaZodOutputFormat(TriageSchema) },
    system: TRIAGE_SYSTEM,
    messages: [
      { role: "user", content: [imageBlock, { type: "text", text: `User's native language: ${lang.english} (${lang.name}, ${lang.code}). Classify this photo.` }] },
    ],
  });
  if (msg.stop_reason === "refusal" || !msg.parsed_output) throw new Error("这张照片无法分析，请换一张试试");
  const t = msg.parsed_output;
  if (t.hazard === "none") return null;
  return blockedGuide({ langCode: lang.code, appliance_native: t.appliance_native, appliance_en: t.appliance_en, brand: t.brand, kind: t.hazard, reason_native: t.reason_native, reason_en: t.reason_en });
}

async function research(imageBlock, send) {
  const messages = [
    {
      role: "user",
      content: [imageBlock, { type: "text", text: "Identify this appliance's brand and model, research how to operate it, and write the research notes." }],
    },
  ];
  const sources = new Map(); // url → { id, title, url, cited }
  const addSource = (url, title, cited = false) => {
    if (!url) return;
    const s = sources.get(url) || { id: sources.size + 1, title: title || url, url, cited: false };
    s.cited ||= cited;
    sources.set(url, s);
  };
  let notes = "";

  // 服务端工具可能因迭代上限返回 pause_turn，原样续上
  for (let round = 0; round < 4; round++) {
    const stream = claude.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      ...FALLBACK,
      output_config: { effort: "medium" },
      system: RESEARCH_SYSTEM,
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: 6 },
        { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3 },
      ],
      messages,
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use") {
        const q = block.input?.query || block.input?.url;
        if (q) send({ type: "search", tool: block.name, query: String(q) });
      } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === "web_search_result") addSource(r.url, r.title);
      } else if (block.type === "web_fetch_tool_result" && block.content?.type === "web_fetch_result") {
        addSource(block.content.url, block.content.content?.title);
      }
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") break;
    for (const b of final.content) {
      if (b.type !== "text") continue;
      notes += b.text;
      for (const c of b.citations || []) if (c.url) addSource(c.url, c.title, true);
    }
    if (final.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: final.content });
  }

  // 被引用的来源排在前面；最多保留 12 个，重新编号
  const list = [...sources.values()].sort((a, b) => Number(b.cited) - Number(a.cited)).slice(0, 12);
  list.forEach((s, i) => (s.id = i + 1));
  send({ type: "sources", sources: list.map(({ id, title, url }) => ({ id, title, url })) });
  return { notes, sources: list };
}

function toGuideFile(g, sources) {
  const clamp = (v) => Math.max(0, Math.min(1000, Number(v) || 0));
  const ids = new Set(g.buttons.map((b) => b.id));
  const kind = (url) => (/reddit|forum|kakaku|zhihu|quora|community|stackexchange|tieba|bbs|answers/i.test(url) ? "forum" : "web");
  return {
    ...g,
    buttons: g.buttons.map((b) => ({ ...b, box: { x: clamp(b.box.x), y: clamp(b.box.y), w: clamp(b.box.w), h: clamp(b.box.h) } })),
    steps: g.steps.map(({ source_ids, ...s }, i) => ({
      step: i + 1,
      ...s,
      button_id: s.button_id && ids.has(s.button_id) ? s.button_id : null,
      sources: source_ids.map((id) => sources.find((x) => x.id === id)?.url).filter(Boolean),
    })),
    sources: sources.map(({ id, title, url, cited }) => ({ id, title, url, kind: kind(url), cited })),
  };
}

// 保存为 JSON 文件并把结果发给前端
const guides = new Map(); // id → 步骤 JSON（讲解阶段的数字人会话从这里取，不信任前端传来的内容）
async function finish(send, res, guide, lang) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const { demoImage, demo, ...content } = guide;
  const file = {
    schema: "appliance-tutor/guide@2",
    id,
    tutorial_id: id, // README 里的名字；和 id 是同一个值
    generated_at: new Date().toISOString(),
    language: { code: lang.code, name: lang.english },
    safety: "ok", // 越过红线时被 content 里的 "blocked" 覆盖
    ...content,
  };
  await fs.writeFile(path.join(GUIDE_DIR, `${id}.json`), JSON.stringify(file, null, 2));
  guides.set(id, file);
  send({ type: "result", guideId: id, file: `/guides/${id}.json`, guide: { ...file, demoImage, demo } });
  res.end();
}

async function loadGuide(id) {
  if (!/^[\w-]+$/.test(id || "")) return null;
  if (guides.has(id)) return guides.get(id);
  try {
    const g = JSON.parse(await fs.readFile(path.join(GUIDE_DIR, `${id}.json`), "utf8"));
    guides.set(id, g);
    return g;
  } catch {
    return null;
  }
}

app.get("/guides/:file", async (req, res) => {
  const id = req.params.file.replace(/\.json$/, "");
  const g = await loadGuide(id);
  if (!g) return res.status(404).end();
  res.setHeader("Content-Disposition", `attachment; filename="appliance-steps-${id}.json"`);
  res.json(g);
});

// =====================================================================================
// 2. 数字人 Ava 会话令牌
// =====================================================================================
app.post("/api/session-token", async (req, res) => {
  if (!HAS_ANAM) return res.status(503).json({ error: "ANAM_API_KEY 未配置（演示模式）" });
  const { lang: code, phase = "greet", guideId, quiet } = req.body || {};
  const lang = langOf(code);
  const base = {
    name: PERSONA.name,
    avatarId: process.env.ANAM_AVATAR_ID || PERSONA.avatarId,
    avatarModel: PERSONA.avatarModel,
    voiceId: lang.voiceId, // 英文 = Ava 默认声音；其他母语换成该语言的女声
    llmId: process.env.ANAM_LLM_ID || PERSONA.llmId,
    languageCode: lang.code,
  };
  let personaConfig;
  if (phase === "lesson") {
    const guide = await loadGuide(guideId);
    if (!guide) return res.status(404).json({ error: "找不到这份步骤" });
    // 越过红线的设备：Ava 只会劝用户联系厂家，不给任何操作工具
    const tools = guide.safety === "blocked" ? [] : LESSON_TOOLS;
    personaConfig = { ...base, systemPrompt: lessonPrompt(lang, guide), tools, skipGreeting: true };
  } else {
    // quiet：待机后重新连上（或从讲解页返回），不再重复说一遍问候语
    personaConfig = quiet
      ? { ...base, systemPrompt: greetPrompt(lang), skipGreeting: true }
      : { ...base, systemPrompt: greetPrompt(lang), initialMessage: lang.greeting, uninterruptibleGreeting: true };
  }
  try {
    // 这个 Anam 账户额度用完 / 密钥失效时，自动换 ANAM_API_KEY_2、_3 …
    const r = await fetchWithKey("ANAM_API_KEY", (key) =>
      fetch("https://api.anam.ai/v1/auth/session-token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ maxSessions: 3, personaConfig }),
      }),
    );
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.message || "Anam 令牌申请失败" });
    res.json({ sessionToken: data.sessionToken });
  } catch (e) {
    console.error("session-token", e?.message || e);
    if (isKeyError(e)) return res.status(429).json({ error: "所有 Anam 密钥的额度都用完了或已失效" });
    res.status(500).json({ error: "无法连接 Anam" });
  }
});

// 数字人自由回答时（不是固定讲解词）补一行英文字幕
app.post("/api/translate", async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 2000);
  if (!text || !HAS_CLAUDE) return res.json({ en: "" });
  try {
    const msg = await claude.beta.messages.create({
      model: MODEL,
      max_tokens: 1000,
      ...FALLBACK,
      output_config: { effort: "low" },
      system: "Translate the user's text into natural English subtitles. Output only the translation. If it is already English, output it unchanged.",
      messages: [{ role: "user", content: text }],
    });
    const en = msg.stop_reason === "refusal" ? "" : msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    res.json({ en });
  } catch (e) {
    console.error("translate", e);
    res.json({ en: "" });
  }
});

// =====================================================================================
// 3. 步骤时间标记 + 问答
// =====================================================================================

// 步骤时间标记。C 的视频工厂写出 output/media/<id>.json（README 7.2 的清单）后直接用真实时间；
// 在那之前按讲解词长度估算，播放器照样能画步骤标记、跳转、重播，不需要重新渲染。
async function manifestOf(guide) {
  try {
    return JSON.parse(await fs.readFile(path.join(MEDIA_DIR, `${guide.id}.json`), "utf8"));
  } catch {
    return { tutorial_id: guide.id, status: "done", video_url: null, estimated: true, chapters: chapters(guide), clips: [] };
  }
}

app.get("/api/render/:id", async (req, res) => {
  const guide = await loadGuide(req.params.id);
  if (!guide) return res.status(404).json({ error: "找不到这份步骤" });
  res.json(await manifestOf(guide));
});

// 问答：只收 tutorial_id，不收照片、不收完整说明
app.post("/api/ask", async (req, res) => {
  const b = req.body || {};
  const guide = await loadGuide(b.tutorial_id || b.guideId);
  if (!guide) return res.status(404).json({ error: "找不到这份步骤" });
  const lang = langOf(b.language || b.lang || guide.language?.code);
  const question = String(b.question || "").trim().slice(0, 500);
  const current = Math.max(1, Math.min(Number(b.current_step) || 1, Math.max(guide.steps.length, 1)));
  const marks = (await manifestOf(guide)).chapters;
  const done = (raw) => res.json(normalizeAsk(raw, guide, current, lang.code, marks));
  const blank = { answer_native: "", answer_en: "", button_id: null, play_from: null, play_to: null };

  // ① 红线：设备本身被拦截，或者问题本身危险 → 不交给模型，直接给固定的安全话术
  if (guide.safety === "blocked") return done({ ...blank, intent: "danger", danger_kind: guide.safety_kind });
  const kind = classifyDanger(question);
  if (kind) return done({ ...blank, intent: "danger", danger_kind: kind });

  // ② 没有 Claude（演示模式）：本地规则
  if (!HAS_CLAUDE) return done(heuristicAsk(question, guide, current, lang.code));

  // ③ Claude 判断问题类型。只发精简目录 + 当前步骤 + 问题
  try {
    const msg = await claude.beta.messages.parse({
      model: ASK_MODEL,
      max_tokens: 4000,
      ...FALLBACK,
      output_config: { effort: "low", format: betaZodOutputFormat(AskSchema) },
      system: ASK_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `User's native language: ${lang.english} (${lang.name}, ${lang.code}).\n` +
            `CATALOG:\n${JSON.stringify(catalog(guide))}\n` +
            `Current step: ${current}\n` +
            `QUESTION: ${question}`,
        },
      ],
    });
    if (msg.stop_reason === "refusal" || !msg.parsed_output) return done({ ...blank, intent: "danger" });
    done(msg.parsed_output);
  } catch (e) {
    console.error("ask", e);
    done(heuristicAsk(question, guide, current, lang.code));
  }
});

const port = Number(process.env.PORT) || 8000;
app.listen(port, () => {
  console.log(`家电数字人老师已启动: http://localhost:${port}`);
  if (!HAS_CLAUDE) console.log("  · 未设置 ANTHROPIC_API_KEY —— 识别使用示例面板");
  if (!HAS_ANAM) console.log("  · 未设置 ANAM_API_KEY —— 数字人使用占位动画 + 浏览器朗读");
});
