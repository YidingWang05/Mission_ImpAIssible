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
import { localizeGuide } from "./localize.js";
import { detectLang } from "./detect.js";
import { PERSONA, greetPrompt, lessonPrompt, LESSON_TOOLS } from "./persona.js";
import { DEMO_GUIDE, DEMO_DANGER_GUIDE } from "./demo.js";
import { TriageSchema, TRIAGE_SYSTEM, blockedGuide, classifyDanger, dangerReply } from "./safety.js";
import { AskSchema, ASK_SYSTEM, catalog, chapters, normalizeAsk, heuristicAsk } from "./brain.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUIDE_DIR = path.join(here, "output", "guides");
const MEDIA_DIR = path.join(here, "output", "media");
await fs.mkdir(GUIDE_DIR, { recursive: true });
await fs.mkdir(MEDIA_DIR, { recursive: true });
const PHOTO_DIR = path.join(here, "output", "photos");
await fs.mkdir(PHOTO_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(here, "public")));
app.use("/media", express.static(MEDIA_DIR));
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
    stt: keysFor("ELEVENLABS_API_KEY").length > 0, // 有 ElevenLabs 密钥：语音识别走 /api/stt（自动识别语言）
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
    // 红线示例（燃气锅炉）：有没有密钥都能演示
    if (sample === "boiler") { send({ type: "status", stage: "safety" }); return await finish(send, res, { ...DEMO_DANGER_GUIDE(lang.code), demo: true }, lang); }
    const demoGuide = sample === "microwave" ? await loadGuide(DEMO_MICROWAVE) : null;
    if (!HAS_CLAUDE && !demoGuide) {
      send({ type: "status", stage: "safety" });
      if (sample === "boiler") return await finish(send, res, { ...DEMO_DANGER_GUIDE(lang.code), demo: true }, lang);
      send({ type: "status", stage: "research" });
      send({ type: "search", query: "AQUA AW-7G 取扱説明書 (demo)" });
      return await finish(send, res, { ...DEMO_GUIDE(lang.code), demo: true }, lang);
    }
    // 预生成好的演示：微波炉（真实识别结果 + 已缓存的视频和旁白），台上直接读缓存，不再调用模型
    if (sample === "microwave") {
      if (!demoGuide) throw new Error("demo guide missing: run the analyze step once or set DEMO_GUIDE_ID");
      send({ type: "status", stage: "safety" });
      send({ type: "status", stage: "research" });
      // 示例是用某一种语言提前生成的：用户选了别的语言就换成那种语言（每种语言只翻译一次，之后读缓存）
      const g = await inLanguage(demoGuide, lang);
      for (const q of ["IKEA TILLREDA microwave manual", "TILLREDA 微波炉 使用说明"]) { send({ type: "search", tool: "web_search", query: q }); await new Promise((r) => setTimeout(r, 900)); }
      send({ type: "result", guideId: g.id, file: `/guides/${g.id}.json`, guide: { ...g, demoImage: "/demo-microwave.jpg", demo: true } });
      return res.end();
    }
    if (!image) throw coded("no_photo", "缺少照片");
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
    if (msg.stop_reason === "refusal" || !msg.parsed_output) throw coded("unreadable", "这张照片无法分析，请换一张试试");
    await finish(send, res, toGuideFile(msg.parsed_output, sources), lang, image);
  } catch (e) {
    console.error("analyze", e);
    // code 给前端用（按用户的语言显示）；error 是给开发者看的原始信息
    send({ type: "error", code: e?.code || "failed", error: e?.message || "识别失败，请稍后再试" });
    res.end();
  }
});

const coded = (code, message) => Object.assign(new Error(message), { code });

// 把一份已有的说明换成用户选的语言。结果存成一份新的说明（编号 = 原编号-语言），
// media_id 指回原来那份，所以视频不用重新生成；旁白按新语言的文字另外合成并缓存。
const TranslationSchema = z.object({ translations: z.array(z.string()) });
async function translateTexts(texts, lang) {
  if (!HAS_CLAUDE) return null;
  const msg = await claude.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    ...FALLBACK,
    output_config: { effort: "low", format: betaZodOutputFormat(TranslationSchema) },
    system:
      "You translate the lines of an appliance lesson, spoken by a friendly teacher to a non-technical user. " +
      "Translate every numbered English line into the target language: plain words, short sentences. " +
      "Words printed on the appliance itself (labels such as Max, Defrost, 800W) and brand or model names stay exactly as written. " +
      "Return exactly one translation per line, in the same order.",
    messages: [{ role: "user", content: `Target language: ${lang.english} (${lang.name}, ${lang.code}).\n\n` + texts.map((t, i) => `${i + 1}. ${t}`).join("\n") }],
  });
  return msg.stop_reason === "refusal" ? null : msg.parsed_output?.translations?.map((t) => t.replace(/^\d+\.\s*/, "")) || null;
}
async function inLanguage(guide, lang) {
  if (guide.language?.code === lang.code || guide.safety === "blocked") return guide;
  const base = guide.media_id || guide.id;
  // 已经是翻译出来的版本：回到原始那份再翻，原始语言直接用原文
  if (base !== guide.id) guide = (await loadGuide(base)) || guide;
  if (guide.language?.code === lang.code) return guide;
  // 翻译失败（没有密钥 / 模型出错）就退回英文版，英文版不需要调用模型
  for (const target of lang.code === "en" ? [lang] : [lang, langOf("en")]) {
    const id = `${base}-${target.code}`;
    const cached = await loadGuide(id);
    if (cached) return cached;
    let g = null;
    try { g = await localizeGuide(guide, target, translateTexts); } catch (e) { console.error("localize", target.code, e?.message || e); }
    if (!g) continue;
    Object.assign(g, { id, tutorial_id: id, media_id: base, generated_at: new Date().toISOString() });
    await fs.writeFile(path.join(GUIDE_DIR, `${id}.json`), JSON.stringify(g, null, 2));
    guides.set(id, g);
    return g;
  }
  return guide;
}

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
  if (msg.stop_reason === "refusal" || !msg.parsed_output) throw coded("unreadable", "这张照片无法分析，请换一张试试");
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
async function finish(send, res, guide, lang, image) {
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
  // 照片只发给模型一次；这里存一份给视频工厂用（之后都靠 tutorial_id）
  if (image) await fs.writeFile(path.join(PHOTO_DIR, `${id}.jpg`), Buffer.from(image, "base64")).catch(() => {});
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
// 视频工厂：后台跑 generate_action_videos.py（按 1→2→3 顺序，fal 结果全部缓存，已生成的步骤直接跳过）
const RENDER_MODEL = process.env.RENDER_MODEL || "kling21";
const RENDER_IDLE_MS = Number(process.env.RENDER_IDLE_MS) || 90_000; // 前端这么久没来轮询就停止生成
const jobs = new Map(); // id → { proc, lastPoll, status, error }

async function photoOf(id) {
  for (const p of [path.join(PHOTO_DIR, `${id}.jpg`), DEMO_PHOTOS[id]].filter(Boolean)) {
    try { await fs.access(p); return p; } catch {}
  }
  return null;
}
// 仓库里那份微波炉说明配的照片
const DEMO_MICROWAVE = process.env.DEMO_GUIDE_ID || "2026-11-15T01-20-02-074Z-75aecb";
const DEMO_PHOTOS = { [DEMO_MICROWAVE]: path.join(here, "samples", "microwave.jpg") };

// 找一个装了 Pillow + requests 的 Python（PATH 里第一个 python 不一定是对的）
let pythonCmd;
async function pickPython() {
  if (pythonCmd !== undefined) return pythonCmd;
  const { spawnSync } = await import("node:child_process");
  const cands = [process.env.PYTHON, "python", "py -3", "python3", "C:/Python313/python.exe"].filter(Boolean).map((c) => c.split(" "));
  pythonCmd = cands.find((c) => spawnSync(c[0], [...c.slice(1), "-c", "import PIL, requests"], { timeout: 20000 }).status === 0) || null;
  console.log("render python:", pythonCmd?.join(" "));
  return pythonCmd;
}

const mediaId = (guide) => guide.media_id || guide.id; // 翻译出来的说明共用原说明的视频
async function startRender(guide) {
  const id = mediaId(guide);
  const job = jobs.get(id);
  if (job?.proc) { job.lastPoll = Date.now(); return job; }
  const photo = await photoOf(id);
  if (!photo || guide.safety === "blocked" || !guide.steps?.length) return null;
  const out = path.join(MEDIA_DIR, id);
  const prev = await scriptManifest(id);
  if (prev && prev.steps.length >= guide.steps.length) { const j = { status: "done", lastPoll: Date.now() }; jobs.set(id, j); return j; }
  const { spawn } = await import("node:child_process");
  const py = await pickPython();
  if (!py) { console.error("render: no python with Pillow + requests found (set PYTHON=...)"); return null; }
  const proc = spawn(py[0], [...py.slice(1), "generate_action_videos.py", "--guide", path.join(GUIDE_DIR, `${id}.json`), "--photo", photo, "--out", out, "--model", RENDER_MODEL],
    { cwd: here, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  const j = { proc, lastPoll: Date.now(), status: "rendering", error: null };
  let tail = "";
  proc.stdout.on("data", (d) => process.stdout.write(`[render ${id.slice(-6)}] ${d}`));
  proc.stderr.on("data", (d) => { tail = (tail + d).slice(-2000); });
  proc.on("exit", (code) => {
    j.proc = null;
    if (j.status === "stopped") return;
    j.status = code === 0 ? "done" : "stopped";
    if (code !== 0) {
      j.error = /fal budget/.test(tail) ? "fal_budget" : /keys are unusable/.test(tail) ? "fal_keys" : "render_failed";
      console.error(`render ${id} exit ${code}: ${tail.split("\n").filter(Boolean).slice(-2).join(" | ")}`);
    }
  });
  jobs.set(id, j);
  return j;
}

setInterval(() => {
  for (const [id, j] of jobs) if (j.proc && Date.now() - j.lastPoll > RENDER_IDLE_MS) {
    console.log(`render ${id}: no polling for ${RENDER_IDLE_MS / 1000}s, stopping`);
    j.status = "stopped";
    j.proc.kill();
  }
}, 10_000).unref();

async function scriptManifest(id) {
  try { return JSON.parse(await fs.readFile(path.join(MEDIA_DIR, id, "manifest.json"), "utf8")); } catch { return null; }
}

// 把脚本的 manifest.json 转成 README 7.2 的清单；没有视频时按讲解词长度估算时间（mode: "estimated"）
async function manifestOf(guide) {
  const mid = mediaId(guide);
  const m = await scriptManifest(mid);
  const job = jobs.get(mid);
  if (!m && !job) return { tutorial_id: guide.id, status: "done", video_url: null, estimated: true, chapters: chapters(guide), clips: [] };
  const byStep = new Map((m?.steps || []).map((s) => [s.step, s]));
  let at = 0;
  const chs = [], clips = [];
  const est = chapters(guide);
  for (const s of guide.steps) {
    const v = byStep.get(s.step);
    if (v) {
      chs.push({ step: s.step, start: +at.toFixed(2), end: +(at + v.duration_s).toFixed(2), ready: true });
      clips.push({ step: s.step, url: `/media/${mid}/${v.file}`, duration: v.duration_s });
      at += v.duration_s;
    } else {
      const e = est[s.step - 1];
      chs.push({ step: s.step, ready: false, est_seconds: +(e.end - e.start).toFixed(1) });
    }
  }
  const all = clips.length === guide.steps.length;
  const status = all ? "done" : job?.status || "stopped";
  return { tutorial_id: guide.id, status, video_url: all && m?.all_steps ? `/media/${mid}/${m.all_steps}` : null,
    chapters: chs, clips, mode: "video", ...(job?.error ? { error: job.error } : {}) };
}

app.post("/api/render", async (req, res) => {
  const guide = await loadGuide(req.body?.tutorial_id || req.body?.guideId);
  if (!guide) return res.status(404).json({ error: "找不到这份步骤" });
  await startRender(guide); // priority_steps 收下但不插队（视频按 1→2→3 顺序生成）
  res.json(await manifestOf(guide));
});

app.get("/api/render/:id", async (req, res) => {
  const guide = await loadGuide(req.params.id);
  if (!guide) return res.status(404).json({ error: "找不到这份步骤" });
  const j = jobs.get(mediaId(guide));
  if (j) j.lastPoll = Date.now();
  res.json(await manifestOf(guide));
});

// ElevenLabs 多语言旁白（Anam 不可用时讲解照样有声音；备用演示视频也用它）。
// 同一句话只合成一次：output/media/tts/<sha1(voice+model+text)>.mp3
const TTS_DIR = path.join(MEDIA_DIR, "tts");
await fs.mkdir(TTS_DIR, { recursive: true });
const TTS_VOICE = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL" // premade "Sarah"（免费档不能用库里的声音）;
const TTS_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";
const ttsInflight = new Map();
async function synth(text) {
  const h = crypto.createHash("sha1").update(`${TTS_VOICE}|${TTS_MODEL}|${text}`).digest("hex").slice(0, 20);
  const file = path.join(TTS_DIR, `${h}.mp3`);
  try { await fs.access(file); return file; } catch {}
  if (ttsInflight.has(h)) return ttsInflight.get(h);
  const p = (async () => {
    const r = await fetchWithKey("ELEVENLABS_API_KEY", (key) =>
      fetch(`https://api.elevenlabs.io/v1/text-to-speech/${TTS_VOICE}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: TTS_MODEL }),
      }));
    if (!r.ok) throw new Error(`elevenlabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
    return file;
  })().finally(() => ttsInflight.delete(h));
  ttsInflight.set(h, p);
  return p;
}
const HAS_TTS = keysFor("ELEVENLABS_API_KEY").length > 0;
async function sendTts(res, text) {
  if (!text) return res.status(400).json({ error: "empty" });
  if (!HAS_TTS) return res.status(503).json({ error: "no ElevenLabs key" });
  try { res.type("audio/mpeg").sendFile(await synth(text.slice(0, 1500))); }
  catch (e) { console.error("tts", e.message); res.status(502).json({ error: "tts failed" }); }
}
// 任意一句话（Ava 的回答、打招呼）
app.get("/api/tts", (req, res) => sendTts(res, String(req.query.text || "").trim()));
// 每一步旁白：缓存键 = 说明编号 + 步骤 + 语言（lang=en 用 narration_en，否则 narration_native）
app.get("/api/narration/:id/:step", async (req, res) => {
  const g = await loadGuide(req.params.id);
  const s = g?.steps?.find((x) => x.step === Number(req.params.step));
  if (!s) return res.status(404).json({ error: "not found" });
  const en = req.query.lang === "en";
  sendTts(res, en ? s.narration_en : s.narration_native);
});

// 语音识别：浏览器录下用户说的一句话（16 kHz WAV）发到这里，用 ElevenLabs Scribe 转成文字。
// Scribe 会自己判断语言，所以用户不用先选对语言；返回 { text, language }（language 只在有把握时给出）。
// hint = 当前对话的语言：句子太短、语言没把握时，按这个语言再识别一次，避免把“下一步”听成别的语言。
const STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";
const STT_LANG = { eng: "en", zho: "zh", cmn: "zh", yue: "zh", spa: "es", vie: "vi", jpn: "ja", kor: "ko", fra: "fr", ara: "ar", hin: "hi", por: "pt" };
const STT_CODE = { en: "eng", zh: "zho", es: "spa", vi: "vie", ja: "jpn", ko: "kor", fr: "fra", ar: "ara", hi: "hin", pt: "por" };
async function transcribe(audio, type, languageCode) {
  const r = await fetchWithKey("ELEVENLABS_API_KEY", (key) => {
    const fd = new FormData();
    fd.append("model_id", STT_MODEL);
    fd.append("tag_audio_events", "false");
    if (languageCode) fd.append("language_code", languageCode);
    fd.append("file", new Blob([audio], { type }), "speech.wav");
    return fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: fd });
  });
  if (!r.ok) throw new Error(`elevenlabs stt ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
app.post("/api/stt", express.raw({ type: () => true, limit: "8mb" }), async (req, res) => {
  if (!keysFor("ELEVENLABS_API_KEY").length) return res.status(503).json({ error: "no ElevenLabs key" });
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length < 4000) return res.json({ text: "", language: null });
  const type = req.headers["content-type"] || "audio/wav";
  const hint = STT_CODE[String(req.query.hint || "")];
  const clean = (t) => String(t || "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim(); // 去掉 (笑声) 这类标注
  try {
    let out = await transcribe(audio, type);
    let language = STT_LANG[out.language_code] || null;
    const sure = language && (out.language_probability ?? 0) >= 0.6;
    if (!sure) {
      language = null;
      if (hint && out.language_code !== hint) out = await transcribe(audio, type, hint);
    }
    const text = clean(out.text);
    // 文字本身的写法比声音更可靠（只有汉字的短句常被听成日文）；太短的一句话不足以判断，不换语言
    const script = detectLang(text);
    if (["zh", "ja", "ko", "ar", "hi"].includes(script)) language = language && script;
    const long = /[぀-ヿ一-鿿가-힯]/.test(text) ? text.length >= 6 : text.split(/\s+/).length >= 3;
    res.json({ text, language: long ? language : null });
  } catch (e) {
    console.error("stt", e?.message || e);
    res.status(502).json({ error: "stt failed" });
  }
});

// 讲解中途换语言（用户改用另一种语言提问）：返回同一份说明的那种语言版本，视频共用
app.post("/api/localize", async (req, res) => {
  const guide = await loadGuide(req.body?.tutorial_id);
  const lang = LANGUAGES.find((l) => l.code === req.body?.lang);
  if (!guide || !lang) return res.status(404).json({ error: "not found" });
  try { res.json(await inLanguage(guide, lang)); }
  catch (e) { console.error("localize", e?.message || e); res.status(500).json({ error: "failed" }); }
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
  // 自动语言检测：回答用“用户这句话的语言”，认不出来就沿用当前的语言（lang）。
  // reply_language 是新增字段：前端据此切换 Ava 的声音和字幕；界面文字不跟着变。
  const supported = (code) => LANGUAGES.find((l) => l.code === String(code || "").toLowerCase().slice(0, 2));
  // heard_language：语音识别听出来的语言（文字太短时比看文字更可靠）
  const local = supported(b.heard_language) || supported(detectLang(question)) || lang;
  const done = (raw, reply = local) => res.json({ ...normalizeAsk(raw, guide, current, reply.code, marks), reply_language: reply.code });
  const blank = { answer_native: "", answer_en: "", button_id: null, play_from: null, play_to: null };

  // ① 红线：设备本身被拦截，或者问题本身危险 → 不交给模型，直接给固定的安全话术
  if (guide.safety === "blocked") return done({ ...blank, intent: "danger", danger_kind: guide.safety_kind });
  const kind = classifyDanger(question);
  if (kind) return done({ ...blank, intent: "danger", danger_kind: kind });

  // ② 没有 Claude（演示模式）：本地规则
  if (!HAS_CLAUDE) return done(heuristicAsk(question, guide, current, local.code));

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
            `Conversation language: ${lang.english} (${lang.name}, ${lang.code}).\n` +
            `Supported languages: ${LANGUAGES.map((l) => `${l.code} = ${l.english}`).join(", ")}.\n` +
            `CATALOG:\n${JSON.stringify(catalog(guide))}\n` +
            `Current step: ${current}\n` +
            `QUESTION: ${question}`,
        },
      ],
    });
    if (msg.stop_reason === "refusal" || !msg.parsed_output) return done({ ...blank, intent: "danger" });
    done(msg.parsed_output, supported(msg.parsed_output.question_language) || lang);
  } catch (e) {
    console.error("ask", e);
    done(heuristicAsk(question, guide, current, local.code));
  }
});

const port = Number(process.env.PORT) || 8000;
app.listen(port, () => {
  console.log(`家电数字人老师已启动: http://localhost:${port}`);
  if (!HAS_CLAUDE) console.log("  · 未设置 ANTHROPIC_API_KEY —— 识别使用示例面板");
  if (!HAS_ANAM) console.log("  · 未设置 ANAM_API_KEY —— 数字人使用占位动画 + 浏览器朗读");
});
