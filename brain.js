// 问答大脑（B）：/api/ask 用到的纯逻辑，不依赖网络，方便单独测试
//
//   catalog()      完整说明 → 发给模型的“精简目录”（不含讲解词全文、资料链接、照片）
//   chapters()     每一步在整段讲解里的开始 / 结束时间（步骤时间标记）
//   normalizeAsk() 模型（或本地规则）的判断 → 前端能直接执行的结果（README 7.3）
//   heuristicAsk() 没有 Claude 时的本地规则分类（演示模式）
//
// 问题分四类（intent）：
//   how_to_use  不会用这台家电          → 播放完整讲解（第 1 步到最后一步）
//   label       看不懂面板上的字 / 图标 → 放大照片上的那个按钮，告诉用户它写的是什么
//   function    不懂某一个功能          → 只播讲这个功能的那几步（剪已有的片段，不重新生成）
//   other / unsure / danger             → 简短回答 / 说不确定 / 红线拒答
import { z } from "zod";
import { dangerReply } from "./safety.js";

export const AskSchema = z.object({
  intent: z.enum(["how_to_use", "label", "function", "other", "unsure", "danger"]),
  question_language: z.string().describe("ISO 639-1 code of the language the QUESTION is written in, e.g. zh, en, es; the conversation language if it cannot be told"),
  answer_native: z.string().describe("one or two short spoken sentences in the reply language (see LANGUAGE rule)"),
  answer_en: z.string().describe("the same answer in English, for subtitles"),
  button_id: z.string().nullable().describe("id of the button the answer is about, or null"),
  play_from: z.number().int().nullable().describe("first step to play (1-based), only for intent=function"),
  play_to: z.number().int().nullable().describe("last step to play (1-based), only for intent=function"),
});

export const ASK_SYSTEM = `You route a user's question about a home appliance. You get a compact CATALOG of its buttons and tutorial steps (already recorded as a video with one chapter per step), the step the user is on, and the QUESTION.

Pick exactly one intent:
- how_to_use: the user doesn't know how to use the appliance in general, or asks to see everything / start over. The app will play the whole tutorial.
- label: the user can't read or understand what is printed on a control (foreign-language text, abbreviation, icon). Set button_id. The app zooms in on that control. Say what the label says and means.
- function: the user wants to know how to do one specific thing, or what one specific control does and how to use it. Set button_id if one control is central, and set play_from / play_to to the smallest range of existing steps that covers it. The app plays only those chapters; nothing new is generated. If no existing step covers it, use label (when it is about one control) or other instead, and answer directly.
- other: a short factual question the catalog answers that needs no video.
- unsure: the catalog does not contain the answer. Say you are not sure and suggest the official manual. Never invent steps, buttons or settings.
- danger: repairs, opening the casing, gas, wiring or electrical faults, smoke or burning smells, bypassing safety locks. Do not explain anything; the app shows its own safety message.

"This button" / "this one" means the current step's button unless the user names another.
LANGUAGE rule: detect the language the QUESTION itself is written in and put its code in question_language. Write answer_native in that language when it is one of the supported languages listed in the message; otherwise write it in the conversation language. If the question is too short or ambiguous to tell (a number, a name, "ok", a word copied from the panel), treat it as the conversation language. Words quoted from the appliance's panel do not count as the question's language.
answer_native is spoken aloud by a friendly tutor: one or two short sentences, no lists. For how_to_use and function, just say in one sentence what you are about to show. Speech recognition may contain mistakes; pick the most sensible meaning.`;

// ---------------------------------------------------------------- 精简目录
export function catalog(guide) {
  return {
    appliance: guide.appliance_en,
    brand: guide.brand,
    model: guide.model,
    model_confidence: guide.model_confidence,
    buttons: guide.buttons.map((b) => ({ id: b.id, label: b.panel_text, name: b.name_native, does: b.function_en })),
    steps: guide.steps.map((s) => ({ n: s.step, button_id: s.button_id, action: s.action_en })),
  };
}

// ---------------------------------------------------------------- 步骤时间标记
const CJK = /[぀-鿿가-힯]/;
// 讲解词念完大约要多久（秒）。C 的真实视频做好后，用真实时间覆盖（见 server.js 的 /api/render/:id）
export function estimateSeconds(text) {
  const t = String(text || "");
  return +(1.2 + t.length * (CJK.test(t) ? 0.26 : 0.075)).toFixed(1);
}

export function chapters(guide) {
  let at = 0;
  return guide.steps.map((s) => {
    const start = +at.toFixed(1);
    at += estimateSeconds(s.narration_native);
    return { step: s.step, start, end: +at.toFixed(1), ready: true };
  });
}

// ---------------------------------------------------------------- 结果整理
// raw: { intent, answer_native, answer_en, button_id, play_from, play_to, nav? }
// 模型说的不直接信：按钮 id、步骤范围都在这里按完整说明校验一遍
export function normalizeAsk(raw, guide, currentStep, langCode, marks = chapters(guide)) {
  const total = guide.steps.length;
  const cur = Math.max(1, Math.min(Number(currentStep) || 1, Math.max(total, 1)));
  const has = (id) => guide.buttons.some((b) => b.id === id);
  const curButton = guide.steps[cur - 1]?.button_id || null;
  let intent = raw.intent;
  let button = has(raw.button_id) ? raw.button_id : null;
  let from = null, to = null;

  if (intent === "how_to_use" && total) [from, to] = [1, total];

  if (intent === "function") {
    button ||= curButton;
    const ok = (n) => Number.isInteger(n) && n >= 1 && n <= total;
    if (ok(raw.play_from) && ok(raw.play_to) && raw.play_from <= raw.play_to) [from, to] = [raw.play_from, raw.play_to];
    else {
      // 模型没给范围：找讲这个按钮的步骤
      const hits = guide.steps.filter((s) => button && s.button_id === button).map((s) => s.step);
      if (hits.length) [from, to] = [Math.min(...hits), Math.max(...hits)];
    }
    // 没有任何一步讲过这个功能 → 不生成新视频，退回“放大按钮 + 一句话说明”
    if (from === null) intent = button ? "label" : "other";
  }

  if (intent === "label") {
    button ||= curButton;
    if (!button) intent = "other";
  }

  let answer = { native: String(raw.answer_native || "").trim(), en: String(raw.answer_en || "").trim() };
  if (intent === "danger") answer = dangerReply(langCode, guide.brand, raw.danger_kind || "other");

  const play = from !== null;
  return {
    type: intent === "danger" ? "danger" : intent === "unsure" ? "unsure" : play ? "play" : "answer_only",
    intent,
    answer_native: answer.native,
    answer_en: answer.en,
    highlight_button: intent === "how_to_use" || intent === "danger" ? null : button,
    zoom: intent === "label",
    play_from: from,
    play_to: to,
    // 要播的片段在整段视频里的时间范围（剪辑用，不重新渲染）
    clip: play && marks[from - 1] && marks[to - 1] ? { start: marks[from - 1].start, end: marks[to - 1].end } : null,
    resume: !play && intent !== "danger",
    nav: raw.nav || null,
  };
}

// ---------------------------------------------------------------- 本地规则（演示模式 / Claude 不可用时）
const NAV = {
  next: /下一步|下一个|继续|\bnext\b|\bcontinue\b/i,
  repeat: /再说|再讲|重复|没听清|\bagain\b|\brepeat\b/i,
  previous: /上一步|上一个|\bback\b|\bprevious\b/i,
};
const RE = {
  label: /什么意思|啥意思|看不懂|不认识|不懂.*(字|文)|写的(是)?什么|什么字|哪个字|翻译|日文|日语|英文|外文|图标|what does .*(say|mean)|can'?t read|don'?t understand .*(label|text|word)|translat|what is written|meaning/i,
  how: /怎么用|如何使用|怎么使用|怎么操作|不会用|从头|完整|整个|全部|教我用|how (do|to) (i |you )?(use|operate)|how does (this|it) work|from the (start|beginning)|whole (thing|tutorial|video)|full (tutorial|video)|everything/i,
  what: /这个(按钮|键|旋钮)|那个(按钮|键|旋钮)|干什么|做什么|干嘛|什么用|有什么用|功能|怎么|如何|what does (this|it|that) do|this button|what('s| is) (this|that)|how (do|to)/i,
};
const SAY = {
  zh: { full: "好的，我从头完整地教你一遍。", part: (name) => `好的，我们只看「${name}」这一部分。`, is: (label, name) => `面板上写的「${label}」就是${name}。`, unsure: "这个我不确定，建议看一下官方说明书。" },
  en: { full: "Sure, let me walk you through the whole thing from the start.", part: (name) => `Okay, let's look at just the ${name} part.`, is: (label, name) => `The label ${label} means ${name}.`, unsure: "I'm not sure about that — please check the official manual." },
};

// 问题里提到了哪个按钮：先找名字 / 面板原文，再按中文双字词、英文单词去匹配按钮说明
function findButton(question, guide) {
  const q = question.toLowerCase();
  const named = guide.buttons.find((b) => [b.panel_text, b.name_native, b.name_en].some((t) => t && t.length > 1 && q.includes(String(t).toLowerCase())));
  if (named) return { id: named.id, named: true };
  const stop = new Set(["怎么", "什么", "这个", "那个", "如何", "可以", "一下", "按钮", "一个", "我想", "the", "how", "what", "does", "this", "that", "button", "use", "can", "you", "for"]);
  const grams = new Set();
  for (const run of q.match(/[぀-鿿]+/g) || []) for (let i = 0; i + 2 <= run.length; i++) grams.add(run.slice(i, i + 2));
  for (const w of q.match(/[a-z]{3,}/g) || []) grams.add(w);
  let best = null, bestScore = 0;
  for (const b of guide.buttons) {
    const taught = guide.steps.filter((s) => s.button_id === b.id).flatMap((s) => [s.action_native, s.action_en, s.narration_native, s.narration_en]);
    const text = [b.panel_text, b.name_native, b.name_en, b.function_native, b.function_en, ...taught].join(" ").toLowerCase();
    let score = 0;
    for (const g of grams) if (!stop.has(g) && text.includes(g)) score++;
    if (score > bestScore) [best, bestScore] = [b.id, score];
  }
  return { id: best, named: false };
}

export function heuristicAsk(question, guide, currentStep, langCode) {
  const q = String(question || "").trim();
  const say = SAY[langCode] || SAY.en;
  const blank = { answer_native: "", answer_en: "", button_id: null, play_from: null, play_to: null };

  if (q.length <= 14) for (const [nav, re] of Object.entries(NAV)) if (re.test(q)) return { ...blank, intent: "other", nav };

  const found = findButton(q, guide);
  const mentioned = found.id;
  const id = mentioned || guide.steps[Math.max(0, (Number(currentStep) || 1) - 1)]?.button_id || null;
  const b = guide.buttons.find((x) => x.id === id);
  const name = (x) => x.name_native;
  const does = (x) => x.function_native;
  const join = (...parts) => parts.join(langCode === "zh" || langCode === "ja" ? "" : " ");
  const taught = b && guide.steps.some((s) => s.button_id === b.id);

  const label = () => ({ ...blank, intent: "label", button_id: b.id, answer_native: join(say.is(b.panel_text, name(b)), does(b)), answer_en: `${SAY.en.is(b.panel_text, b.name_en)} ${b.function_en}` });
  if (RE.label.test(q) && b) return label();
  if (RE.how.test(q) && !found.named) return { ...blank, intent: "how_to_use", answer_native: say.full, answer_en: SAY.en.full };
  if ((mentioned || RE.what.test(q)) && b) {
    if (!taught) return label(); // 没有哪一步讲过它：放大按钮直接说明，不生成新视频
    return { ...blank, intent: "function", button_id: b.id, answer_native: join(say.part(name(b)), does(b)), answer_en: `${SAY.en.part(b.name_en)} ${b.function_en}` };
  }
  return { ...blank, intent: "unsure", answer_native: say.unsure, answer_en: SAY.en.unsure };
}
