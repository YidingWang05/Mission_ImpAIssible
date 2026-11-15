import { boxCenter } from "./boxes.js";
// 家电小老师 —— 前端
// 输入：① 家电照片 ② 语言 ③ 用户的疑问
// 流程：Ava 打招呼 → 拍照（+ 可选疑问）→ 服务端先做安全红线检查，再识别型号并联网查资料，生成步骤 JSON（只用 ①②）
//      → 讲解：像视频一样连续播放（每一步一个章节，进度条上有步骤标记）；
//        用户一提问就自动暂停 → 简短回答 → 按问题类型：播完整讲解 / 放大按钮 / 只播相关的那几步 / 继续播放
const $ = (s) => document.querySelector(s);

const state = {
  cfg: null,
  lang: null,          // 用户在首页选的语言：界面文字一直用它
  halted: false,       // 用户按了“停一下”：Ava 不出声，直到按“继续说”或用户做了别的操作
  haltResume: null,    // 停下的时候在做什么（"lesson" 播讲解 / "line" 说一句话 / "after" 回答完等着继续）
  lastLine: null,      // Ava 最近说的一句固定的话 { native, en, done }
  reply: null,         // Ava 说话和字幕用的语言：一开始等于 lang，之后跟着用户提问的语言走（自动检测）
  avatar: null,        // AnamAvatar（真实数字人）或 FallbackAvatar（演示）
  photo: null,         // { dataUrl, base64, mediaType }
  question: "",        // 用户对家电的疑问（不参与识别，讲解时交给 Ava）
  guide: null,         // 步骤 JSON
  guideFile: null,
  step: -1,            // -1 = 开场白；steps.length = 结束语
  focusId: null,       // 用户最后点过/问过的按钮
  mode: "idle",        // idle | speaking | waiting | thinking
  history: [],
  busy: false,
  gen: 0,              // 每次切换动作 +1，旧的异步流程看到不一致就退出
};

// 讲解播放器：把逐步讲解当成一段带步骤标记的视频。跳转、重播都只是换章节，不重新生成任何内容。
const player = {
  playing: false,      // 正在连续播放
  range: null,         // { to }：只播到第几步（0 起）就停下；null = 一直播到结束
  cursor: 0,           // 继续播放时从第几步开始
  after: null,         // 回答完问题后做什么：{ kind: "resume" } | { kind: "play", from, to }
  asking: false,       // 因为用户提问而暂停中
  chapters: [],        // 步骤时间标记 [{ step, start, end, ready }]
  timer: 0,
};
// 数字人会话管理：Anam 每个会话有时长上限，所以
//   · 讲解按“段”（每一步一段）播放，开始一段之前如果剩余时间不够，就先开一个新会话；
//   · Ava 说完、没人接话时主动断开会话待机；用户一有输入（说话 / 点按钮 / 打字）再开新会话接着讲。
const session = {
  limitMs: 180000,     // 单个会话的时长上限（/api/config 下发）；0 = 不主动续会话
  marginMs: 15000,     // 离上限多远就不再用这个会话开新的一段
  idleMs: 4000,        // 说完后多久没人接话就断开
  pauseEach: false,    // 每讲完一段就停下等用户
  timer: 0,
  busy: null,          // 正在连接中的 Promise，避免重复连接
  rec: null,           // 待机时的浏览器语音识别
};
const SR_LANG = { zh: "zh-CN", en: "en-US", es: "es-ES", vi: "vi-VN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", ar: "ar-SA", hi: "hi-IN", pt: "pt-BR" };
const speakMs = (text) => 2500 + text.length * (/[぀-鿿가-힯]/.test(text) ? 260 : 75); // 念完一段话大约要多久
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lessonActive = () => $("#screen-lesson").classList.contains("active");
const blocked = () => state.guide?.safety === "blocked"; // 越过安全红线：没有步骤，只有安全提醒

// ------------------------------------------------------------------ 启动
init();
async function init() {
  state.cfg = await fetch("/api/config").then((r) => r.json());
  const sc = state.cfg.session || {};
  if (Number.isFinite(sc.limitSeconds)) session.limitMs = sc.limitSeconds * 1000;
  if (Number.isFinite(sc.idleSeconds)) session.idleMs = sc.idleSeconds * 1000;
  session.pauseEach = !!sc.pauseEachSection;
  const sel = $("#lang");
  for (const l of state.cfg.languages) sel.add(new Option(`${l.name} · ${l.english}`, l.code));
  const pref = (navigator.languages || [navigator.language]).map((x) => x.slice(0, 2).toLowerCase());
  sel.value = pref.find((p) => state.cfg.languages.some((l) => l.code === p)) || "en";
  sel.onchange = () => applyLang(sel.value);
  applyLang(sel.value);
  $("#hero-slot").append($("#avatar"));

  // Ava 的形象照：数字人视频连上前显示
  const poster = $("#avatar-poster");
  poster.onload = () => $("#avatar").classList.add("has-poster");
  poster.onerror = () => poster.classList.add("broken");
  poster.src = state.cfg.persona.image;

  // 示例按钮一直显示：微波炉（预生成好的视频 + 旁白，没有时服务器退回演示面板）、燃气锅炉（红线）
  $("#btn-sample").hidden = false;
  $("#btn-sample-danger").hidden = false;

  $("#btn-start").onclick = start;
  $("#photo").onchange = onPhoto;
  $("#btn-analyze").onclick = () => analyze();
  $("#btn-sample").onclick = () => analyze({ sample: "microwave" });
  $("#btn-sample-danger").onclick = () => analyze({ sample: "boiler" });
  $("#btn-play").onclick = togglePlay;
  $("#btn-hush").onclick = (e) => { e.stopPropagation(); hush(); };
  // 开始打字提问就自动暂停；什么都没问就接着播
  $("#ask").oninput = () => { if ($("#ask").value.trim() && lessonActive()) pauseForQuestion(); };
  $("#ask").onblur = () => {
    if ($("#ask").value.trim()) return;
    if (player.asking && state.mode !== "thinking" && state.mode !== "speaking") runAfter();
    else armIdleCut();
  };
  // 准备打字时先把 Ava 叫回来，回答就不用再等连接
  $("#ask").onfocus = () => { if (lessonActive()) ensureSession(); };
  // 待机时点一下 Ava 也能把她叫回来
  $("#avatar").onclick = () => ensureSession().then(() => armIdleCut(20000));
  $("#btn-back").onclick = backToCapture;
  $("#btn-rec").onclick = toggleRecording;
  document.querySelectorAll(".chip").forEach((b) => (b.onclick = () => command(b.dataset.cmd, { fromTap: true })));
  $("#ask-form").onsubmit = (e) => {
    e.preventDefault();
    const q = $("#ask").value.trim();
    if (!q) return;
    $("#ask").value = "";
    userSays(q);
  };
  $("#overlay").addEventListener("click", (e) => {
    const id = e.target.closest?.("[data-id]")?.dataset.id;
    if (id) explainButton(id);
  });
}

function applyLang(code) {
  state.lang = state.cfg.languages.find((l) => l.code === code);
  state.reply = state.lang;
  const ui = state.lang.ui;
  document.documentElement.lang = code;
  document.documentElement.dir = state.lang.rtl ? "rtl" : "ltr";
  document.querySelectorAll("[data-t]").forEach((el) => { if (ui[el.dataset.t]) el.textContent = ui[el.dataset.t]; });
  document.querySelectorAll("[data-ph]").forEach((el) => (el.placeholder = ui[el.dataset.ph] || ""));
  // 图标按钮没有文字：把提示和读屏文字也换成这种语言
  document.querySelectorAll("[data-tt]").forEach((el) => { el.title = ui[el.dataset.tt] || ""; el.setAttribute("aria-label", el.title); });
  document.title = ui.appName;
  const d = state.cfg.demo, note = $("#demo-note");
  note.hidden = !(d.claude || d.avatar);
  note.textContent = `${ui.demoMode} · ${[d.avatar && ui.demoAvatar, d.claude && ui.demoClaude].filter(Boolean).join(" · ")}`;
}

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("active", s.id === id));
}

function placeAvatar(slot) {
  slot.append($("#avatar"));
  const v = $("#avatar-video");
  if (v.srcObject) v.play().catch(() => {});
}

function setBadge(t) { $("#avatar-state").textContent = t; }

// ------------------------------------------------------------------ 1. 打招呼
async function start() {
  $("#btn-start").disabled = true;
  $("#lang").disabled = true; // 声音和听写语言在会话里定好了
  setBadge("…");
  state.avatar = await connectAvatar({ phase: "greet" });
  setBadge("");
  show("screen-capture");
  placeAvatar($("#hero-slot-2"));
  $("#greet-bubble").textContent = state.lang.greeting;
  // 真实数字人的问候由 persona 的 initialMessage 说出；演示数字人用朗读
  state.lastLine = { native: state.lang.greeting, en: "", done: false };
  if (!state.avatar.speaksGreetingItself) say(state.lang.greeting).then((r) => { if (r !== "interrupted") state.lastLine.done = true; });
  renderHush();
  startCaptureListener();
  armIdleCut(30000); // 问候语说完会更早断开（见 onFreeSpeech）；这里兜底
}

// ---------- 会话续期 / 待机 ----------
// Ava 要说话之前调用：会话已经断开，或者剩下的时间不够说完 needMs，就先开一个新会话。
async function ensureSession(needMs = 20000) {
  clearTimeout(session.timer);
  const a = state.avatar;
  if (!(a instanceof AnamAvatar)) return;
  const stale = session.limitMs > 0 && a.ageMs + needMs + session.marginMs > session.limitMs;
  if (a.connected && !stale) return;
  session.busy ||= (async () => {
    stopIdleListener();
    setBadge("…");
    try {
      const lesson = lessonActive() && state.guide;
      state.avatar = await connectAvatar(lesson ? { phase: "lesson", guideId: state.guide.id } : { phase: "greet", quiet: true });
    } finally {
      session.busy = null;
      setBadge("");
      renderListen(state.avatar.listening ? "on" : "off");
    }
  })();
  return session.busy;
}

// Ava 说完了：过一会儿没人接话就断开会话（不占时长），等用户输入
function armIdleCut(ms = session.idleMs) {
  clearTimeout(session.timer);
  if (!(state.avatar instanceof AnamAvatar) || !state.avatar.connected) return;
  session.timer = setTimeout(cutSession, ms);
}

async function cutSession() {
  const a = state.avatar;
  if (!(a instanceof AnamAvatar) || !a.connected || session.busy) return;
  // 还在播、还在想、Ava 还在出声：不断开
  if (player.playing || state.mode === "thinking" || free.text || a.speaking) return;
  await a.disconnect();
  standby();
}

// 会话断开后的待机状态（主动断开，或者 Anam 那边到了时长上限）
function standby() {
  setBadge("💤");
  renderListen("standby");
  if (lessonActive()) startIdleListener();
}

// 待机时没有 Anam 的麦克风，用浏览器自带的语音识别听用户说话；听到就交给 userSays（会自动开新会话）
async function startIdleListener() {
  if (session.rec) return;
  // 优先用服务器的语音识别（所有浏览器都能用，自动识别语言）；没有密钥或没有麦克风权限时退回浏览器自带的
  if (state.cfg.stt) {
    const token = (session.rec = { abort: sttStop });
    const ok = await sttStart({
      onHear: () => { renderListen("hear"); showHeard("…", true); },
      onPartial: (t) => showHeard(t, true),
      onText: (text, heard) => {
        if (session.rec !== token) return;
        if (!text) { showHeard(""); return renderListen("standby"); } // 只是噪音
        stopIdleListener();
        heardSpeech(text, heard);
      },
    });
    if (session.rec !== token) { if (!session.rec) sttStop(); return; } // 等麦克风的时候已经不在待机了
    if (ok) return;
    session.rec = null;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || session.rec) return;
  const rec = new SR();
  rec.lang = SR_LANG[state.reply.code] || state.reply.code;
  rec.onresult = (e) => {
    const text = e.results[e.results.length - 1][0].transcript;
    stopIdleListener();
    heardSpeech(text);
  };
  rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") stopIdleListener(); };
  rec.onend = () => setTimeout(() => { if (session.rec === rec) try { rec.start(); } catch {} }, 300); // 一直听到有输入为止
  session.rec = rec;
  try { rec.start(); } catch { session.rec = null; }
}

function stopIdleListener() {
  const rec = session.rec;
  session.rec = null;
  try { rec?.abort(); } catch {}
}

// ---------- 语音识别：一直在听 → /api/stt（ElevenLabs Scribe，自动识别语言）----------
// 一直听麦克风的音量：声音明显高过环境噪音就开始录，安静 0.6 秒算说完，把这一句发给服务器。
// 说话过程中每隔 1 秒左右把已经录到的部分先送去识别一次（onPartial），页面上能马上看到字，不用等整句说完。
// 开头留 0.35 秒的预录，第一个字不会被切掉。handlers: { gate?, onHear?, onPartial?(text), onText(text, language) }
const mic = { stream: null, ctx: null, src: null, node: null, on: null };
const STT = { block: 2048, endMs: 600, minMs: 300, maxMs: 15000, partialMs: 1000 };
async function sttStart(handlers) {
  sttStop();
  try {
    if (!mic.stream?.active) mic.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = (mic.ctx ||= new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === "suspended") await ctx.resume();
    const src = (mic.src = ctx.createMediaStreamSource(mic.stream));
    const node = (mic.node = ctx.createScriptProcessor(STT.block, 1, 1));
    const silent = ctx.createGain();
    silent.gain.value = 0; // 只分析，不把麦克风的声音放出来
    src.connect(node); node.connect(silent); silent.connect(ctx.destination);
    const blockMs = (STT.block / ctx.sampleRate) * 1000;
    const preBlocks = Math.ceil(350 / blockMs);
    let floor = 0.01, pre = [], rec = null, quiet = 0, loud = 0, lastPartial = 0, busy = false;
    node.onaudioprocess = (e) => {
      const h = mic.on;
      if (!h) return;
      if (h.gate && !h.gate()) { rec = null; pre = []; loud = 0; return; } // Ava 自己在出声：不收音
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      const voiced = rms > Math.max(0.015, floor * 3);
      if (!rec) {
        if (!voiced) floor = floor * 0.95 + rms * 0.05; // 跟着环境噪音慢慢调整
        pre.push(d);
        if (pre.length > preBlocks) pre.shift();
        loud = voiced ? loud + 1 : 0;
        if (loud >= 3) { rec = pre; pre = []; quiet = 0; lastPartial = performance.now(); h.onHear?.(); }
        return;
      }
      rec.push(d);
      quiet = voiced ? 0 : quiet + 1;
      const total = rec.length * blockMs, tail = quiet * blockMs;
      if (tail < STT.endMs && total < STT.maxMs) {
        // 还在说：先识别已经录到的部分，给页面一个中间结果
        if (h.onPartial && !busy && total < 12000 && performance.now() - lastPartial > STT.partialMs) {
          busy = true;
          lastPartial = performance.now();
          const mine = rec;
          sttTranscribe(rec.slice(), ctx.sampleRate, true).then(
            (o) => { busy = false; if (mic.on === h && rec === mine && o.text) h.onPartial(o.text); },
            () => { busy = false; },
          );
        }
        return;
      }
      const blocks = rec;
      rec = null; loud = 0;
      if (total - tail < STT.minMs) return h.onText?.("", null); // 太短：咳嗽、碰到桌子
      sttSend(blocks, ctx.sampleRate, h);
    };
    mic.on = handlers;
    return true;
  } catch (e) {
    console.warn("microphone unavailable", e?.name || e);
    sttStop();
    return false;
  }
}

function sttStop() {
  mic.on = null;
  try { mic.node?.disconnect(); mic.src?.disconnect(); } catch {}
  if (mic.node) mic.node.onaudioprocess = null;
  mic.node = mic.src = null;
}

async function sttTranscribe(blocks, rate, partial = false) {
  // 拼起来 → 降到 16 kHz 单声道 → WAV
  const n = blocks.reduce((a, b) => a + b.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const b of blocks) { all.set(b, o); o += b.length; }
  const k = rate / 16000, m = Math.floor(n / k);
  const v = new DataView(new ArrayBuffer(44 + m * 2));
  const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + m * 2, true); str(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, m * 2, true);
  for (let i = 0; i < m; i++) {
    const a = Math.floor(i * k), b = Math.min(n, Math.max(a + 1, Math.floor((i + 1) * k)));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s / (b - a))) * 0x7fff, true);
  }
  let out = {};
  try {
    const r = await fetch(`/api/stt?hint=${state.reply.code}${partial ? "&partial=1" : ""}`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: v.buffer });
    if (r.ok) out = await r.json();
  } catch (e) { console.warn("stt", e); }
  return { text: out.text || "", language: out.language || null };
}

async function sttSend(blocks, rate, h) {
  const out = await sttTranscribe(blocks, rate);
  if (mic.on === h) h.onText?.(out.text, out.language);
}

// ---------- 听到一句话之后交给谁 ----------
const captureActive = () => $("#screen-capture").classList.contains("active");
function heardSpeech(text, heard) {
  text = String(text || "").trim();
  showHeard(text);
  if (!text) return;
  // “停 / 等一下”“继续”在哪一页都管用
  if (text.length <= 14 && QUICK.pause.test(text)) return hush(true);
  if (text.length <= 14 && QUICK.resume.test(text) && state.halted) return hush(false);
  if (captureActive()) {
    // 拍照页：说的话就是“对这个家电的疑问”，填进输入框（还可以再改）
    const q = $("#question");
    q.value = (q.value.trim() ? q.value.trim() + " " : "") + text;
    return;
  }
  userSays(text, heard);
}

// 拍照页一直在听（不用按任何按钮）。这一页 Ava 自己的麦克风是关着的（见 AnamAvatar.connect），
// 所以不会出现“她也回答一遍”；她自己出声的时候我们不收音，免得把她的话听进去。
async function startCaptureListener() {
  if (!state.cfg.stt || !(state.avatar instanceof AnamAvatar)) return; // 演示数字人自己有一个一直开着的识别
  await sttStart({
    gate: () => captureActive() && !state.busy && !state.avatar?.speaking,
    onHear: () => showHeard("…", true),
    onPartial: (t) => showHeard(t, true),
    onText: (t, heard) => heardSpeech(t, heard),
  });
}

// ---------- 随时让 Ava 停下 / 接着说 ----------
// 停：马上闭嘴，讲解和视频也停住。继续：从停下的地方接着来 ——
//   讲解播到一半 → 这一步从头重播；一句话说到一半（问候语、回答）→ 这句话重说一遍；回答完等着继续 → 接着播。
// 用户做了别的操作（点下一步、提问…）就自动解除“停下”。
function hush(stop = !state.halted) {
  if (stop === state.halted) return;
  state.halted = stop;
  renderHush();
  if (stop) {
    const lesson = lessonActive() && state.guide && !blocked();
    state.haltResume = lesson && player.playing ? "lesson" : state.lastLine && !state.lastLine.done ? "line" : lesson && (player.asking || player.after) ? "after" : null;
    state.gen++; // 取消“说完自动接下一步”
    clearTimeout(player.timer);
    clearTimeout(session.timer);
    if (lesson && player.playing) { player.playing = false; $("#stage-video").pause(); }
    state.avatar?.interrupt();
    free = { text: "", gen: -1 };
    state.mode = "waiting";
    if (lesson) renderChapters();
    armIdleCut(20000);
    return;
  }
  const how = state.haltResume;
  state.haltResume = null;
  if (how === "lesson") return resume();
  if (how === "line") {
    const l = state.lastLine, gen = ++state.gen;
    return speakLine(l.native, l.en).then((r) => {
      if (gen !== state.gen || r === "interrupted") return;
      if (lessonActive() && state.guide) runAfter(); else armIdleCut();
    });
  }
  if (lessonActive() && state.guide && !blocked()) runAfter();
}

function renderHush() {
  const b = $("#btn-hush"), ui = state.lang.ui;
  b.textContent = state.halted ? "▶" : "⏸";
  b.classList.toggle("on", state.halted);
  b.title = state.halted ? ui.resumeTalk : ui.stopTalk;
  b.setAttribute("aria-label", b.title);
}

async function connectAvatar(opts) {
  const make = (Cls) => {
    const a = new Cls();
    a.onUserText = userSays;
    a.onUserSpeech = onUserSpeech;
    a.onListenChange = renderListen;
    a.onTool = onTool;
    a.onFreeSpeech = onFreeSpeech;
    a.onClosed = () => { if (state.avatar === a) standby(); };
    return a;
  };
  if (!state.cfg.demo.avatar) {
    const a = state.avatar instanceof AnamAvatar ? state.avatar : make(AnamAvatar);
    try {
      await a.connect({ lang: state.reply, ...opts });
      return a;
    } catch (e) {
      console.warn("数字人连接失败，改用演示数字人", e);
    }
  }
  const f = state.avatar instanceof FallbackAvatar ? state.avatar : make(FallbackAvatar);
  await f.connect({ lang: state.reply });
  return f;
}

// ------------------------------------------------------------------ 2. 拍照 + 识别
async function onPhoto(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  state.photo = await downscale(file, 1600);
  const img = $("#photo-preview");
  img.src = state.photo.dataUrl;
  img.hidden = false;
  $("#btn-analyze").disabled = false;
  $("#capture-error").hidden = true;
}

function downscale(file, maxSide) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxSide / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.88);
      URL.revokeObjectURL(img.src);
      resolve({ dataUrl, base64: dataUrl.split(",")[1], mediaType: "image/jpeg" });
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

async function analyze({ sample = false } = {}) {
  if (state.busy) return;
  state.busy = true;
  const ui = state.lang.ui;
  const btn = $("#btn-analyze");
  btn.disabled = true;
  btn.textContent = ui.analyzing;
  $("#capture-error").hidden = true;
  state.question = $("#question").value.trim(); // 留给 Ava 在讲解时回答
  const box = $("#research");
  box.hidden = false;
  box.classList.remove("done");
  $("#research-text").textContent = ui.researching;
  $("#research-log").innerHTML = "";
  state.avatar.interrupt();
  $("#greet-bubble").textContent = ui.lookingAt;
  say(ui.lookingAt); // 会话待机时不出声，只显示在气泡里

  try {
    // 只把照片和语言发给识别接口
    const r = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lang: state.lang.code,
        image: sample ? null : state.photo?.base64,
        mediaType: state.photo?.mediaType,
        sample: sample || undefined,
      }),
    });
    let result = null;
    for await (const ev of ndjson(r)) {
      if (ev.type === "status" && ev.stage === "safety") logResearch(`🛡️ ${ui.checking}`);
      else if (ev.type === "search") logResearch(`🔎 ${ui.searching}: ${ev.query}`);
      else if (ev.type === "sources") ev.sources.slice(0, 5).forEach((s) => logResearch(`📄 ${s.title}`));
      else if (ev.type === "error") throw Object.assign(new Error(ev.error), { code: ev.code });
      else if (ev.type === "result") result = ev;
    }
    if (!result) throw new Error("no result");
    box.classList.add("done");
    state.guide = result.guide;
    state.guideFile = result.file;
    await enterLesson(result.guide.demoImage || state.photo.dataUrl);
  } catch (e) {
    // 出错信息用用户选的语言显示；服务器的原始信息只进控制台
    console.error("analyze", e);
    $("#capture-error").textContent = ui[{ no_photo: "noPhoto", unreadable: "unreadable" }[e.code]] || ui.failed;
    $("#capture-error").hidden = false;
  } finally {
    btn.textContent = ui.analyze;
    btn.disabled = !state.photo;
    state.busy = false;
  }
}

async function* ndjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

function logResearch(text) {
  const li = document.createElement("li");
  li.textContent = text;
  li.title = text;
  $("#research-log").append(li);
}

// ------------------------------------------------------------------ 3. 讲解
async function enterLesson(imgSrc) {
  const g = state.guide;
  if (state.avatar instanceof AnamAvatar) sttStop(); // 拍照页的“一直在听”到此为止；讲解页由 Ava 自己听，待机时再换回我们的识别
  state.halted = false; state.haltResume = null; state.lastLine = null;
  renderHush();
  const img = $("#stage-img");
  await new Promise((res) => { img.onload = res; img.src = imgSrc; });
  fitStage();
  window.onresize = fitStage;
  $("#appliance-name").textContent = g.appliance_native === g.appliance_en ? g.appliance_native : `${g.appliance_native} · ${g.appliance_en}`;
  $("#model-name").textContent = [g.brand, g.model].filter((x) => x && x !== "unknown").join(" ") || g.goal_native;
  $("#json-link").href = state.guideFile;
  renderStepList();
  renderSources();
  show("screen-lesson");
  placeAvatar($("#pip-slot"));
  state.history = [];
  state.focusId = null;
  state.step = -1;
  $(".lesson").classList.toggle("blocked", blocked());
  Object.assign(player, { playing: false, range: null, cursor: 0, after: null, asking: false, chapters: [] });
  $("#chapter-track").innerHTML = "";
  hideDanger();
  showHeard("");
  clearZoom();
  drawOverlay({});
  // 步骤时间标记（真实视频做好前由服务端按讲解词长度估算）
  player.clips = {};
  if (!blocked() && g.steps.length) {
    try { applyManifest(await fetch("/api/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tutorial_id: g.id }) }).then((r) => r.json())); } catch {}
    if (player.chapters.length !== g.steps.length) player.chapters = g.steps.map((_, i) => ({ step: i + 1, start: i, end: i + 1, ready: true }));
    pollRender(g.id);
  }
  renderChapters();

  // 讲解阶段换一个“知道这台家电”的数字人会话（步骤 JSON + 客户端工具）
  if (state.avatar instanceof AnamAvatar) {
    setBadge("…");
    state.avatar = await connectAvatar({ phase: "lesson", guideId: g.id });
    setBadge("");
  }
  if (!g.recognized) {
    await speakLine(g.intro_native, g.intro_en);
    return backToCapture();
  }
  if (blocked()) {
    // 安全红线：不讲任何步骤，只说明原因 + 建议联系厂家官方售后 / 房东
    const gen = ++state.gen;
    $("#progress").textContent = "⚠️";
    $("#step-chip").textContent = "";
    $("#action").innerHTML = "";
    showDanger(g.safety_message_native, g.safety_message_en);
    await speakLine(g.safety_message_native, g.safety_message_en);
    if (gen === state.gen) { state.mode = "waiting"; armIdleCut(); }
    return;
  }
  goto(-1);
}

function fitStage() {
  const img = $("#stage-img");
  if (!img.naturalWidth) return;
  const aspect = img.naturalWidth / img.naturalHeight;
  const maxH = window.innerHeight * (window.innerWidth >= 900 ? 0.72 : 0.55);
  $("#photo-wrap").style.maxWidth = `${Math.floor(maxH * aspect)}px`;
}

async function backToCapture() {
  state.gen++;
  clearTimeout(player.timer);
  Object.assign(player, { playing: false, range: null, after: null, asking: false });
  state.avatar?.interrupt();
  stopRecording();
  clearZoom();
  show("screen-capture");
  placeAvatar($("#hero-slot-2"));
  stopIdleListener();
  clearTimeout(session.timer);
  // 回到拍照页不马上连数字人：用户点一下 Ava 或开始下一次讲解时再连，不占会话时长
  if (state.avatar instanceof AnamAvatar) { await state.avatar.disconnect(); setBadge("💤"); }
  startCaptureListener();
}

const steps = () => state.guide.steps;

// 播放第 i 步（-1 = 开场白，steps.length = 结束语）。播完自动接下一步，直到结束或播完 player.range。
async function goto(i, { keepRange = false } = {}) {
  const g = state.guide;
  if (blocked()) return;
  const gen = ++state.gen;
  clearTimeout(player.timer);
  if (!keepRange) player.range = null;
  Object.assign(player, { playing: true, after: null, asking: false });
  clearZoom();
  hideDanger();
  state.step = Math.max(-1, Math.min(i, steps().length));
  player.cursor = Math.max(0, state.step);
  state.focusId = null;
  const ui = state.lang.ui;
  const total = steps().length;
  const s = steps()[state.step];
  $("#progress").textContent = state.step < 0 ? `0/${total}` : `${Math.min(state.step + 1, total)}/${total}`;
  $("#step-chip").textContent = s ? `${ui.step.replace("{n}", state.step + 1)} · ${s.action_native}` : "";
  $("#action").innerHTML = s
    ? `${esc(ui.step.replace("{n}", state.step + 1))} · ${esc(s.action_native)}${s.action_en !== s.action_native ? `<small>${esc(s.action_en)}</small>` : ""}`
    : "";
  renderStepList();
  drawOverlay({ target: s?.button_id || null });
  if (!s) playClip(null);
  renderChapters(0);

  let result;
  if (state.step === -1) result = await speakLine(g.intro_native, g.intro_en);
  else if (s) {
    const clip = playClip(state.step + 1);
    result = await speakLine(s.narration_native, s.narration_en, renderChapters);
    if (result === "done" || result === "timeout") await clip; // 旁白说完，等这一步的视频也播完
  }
  else result = await speakLine(g.closing_native, g.closing_en);
  if (gen !== state.gen) return;
  // 会话在这一段中途被断开（到了时长上限）→ 开新会话把这一段重讲一遍；同一段连续断两次就停下等用户
  if (result === "closed") {
    if (player.closedAt === state.step) { player.closedAt = null; player.playing = false; return waitForUser(); }
    player.closedAt = state.step;
    return resume();
  }
  player.closedAt = null;
  // 用户开口把讲解打断了 → 当作提问暂停，回答完从这一步重新播
  if (result === "interrupted") return pauseForQuestion();
  player.cursor = state.step + 1;

  if (state.step < 0) {
    // 开场白之后：先回答用户拍照时提的疑问（回答里会决定播哪几步），否则从第 1 步开始
    if (state.question) {
      const q = state.question;
      state.question = "";
      return answerQuestion(q);
    }
    return goto(0);
  }
  if (!s) { player.playing = false; return waitForUser(); } // 结束语说完
  renderChapters(1);
  if (player.range && state.step >= player.range.to) {
    // 这个问题需要的范围播完了：停下，问还有没有别的问题（用户说“继续”就接着往下播）
    player.range = null;
    player.playing = false;
    renderChapters();
    await speakLine(state.reply.ui.more, "Any other questions?");
    if (gen !== state.gen) return;
    return waitForUser();
  }
  // 分段模式：每讲完一段就停下，用户说“下一步 / 继续”再开始下一段
  if (session.pauseEach) { player.playing = false; return waitForUser(); }
  await sleep(500);
  if (gen !== state.gen) return;
  goto(state.step + 1, { keepRange: true }); // 下一段开始前 speakLine 会检查会话，必要时换新会话
}

// ---------- 视频片段：后台轮询清单，做好一步就能播一步（每步小视频 + 播放列表）----------
function applyManifest(m) {
  if (!m?.chapters) return;
  player.manifest = m;
  for (const c of m.clips || []) player.clips[c.step] = c.url;
  // 步骤标记：有真实时间就用，没有（还在生成）就按步骤等分
  const timed = m.chapters.every((c) => c.start != null);
  player.chapters = m.chapters.map((c, i) => (timed ? c : { step: c.step, start: i, end: i + 1, ready: c.ready }));
}
async function pollRender(id) {
  clearTimeout(player.pollTimer);
  if (!state.guide || state.guide.id !== id || !lessonActive()) return;
  if (player.manifest && player.manifest.status !== "rendering") return;
  try { applyManifest(await fetch(`/api/render/${id}`).then((r) => r.json())); renderChapters(); } catch {}
  player.pollTimer = setTimeout(() => pollRender(id), 4000);
}
// 播这一步的视频（静音，旁白由 Ava / ElevenLabs 说）；没做好就显示照片 + 标注
function playClip(step) {
  const v = $("#stage-video");
  const url = step != null && player.clips?.[step];
  $("#ai-credit").hidden = !url; // 只有画面上是生成的视频时才显示“由 Fal.ai 生成”
  if (!url) { v.pause(); v.hidden = true; return Promise.resolve(); }
  v.hidden = false;
  if (!v.src.endsWith(url)) v.src = url;
  v.currentTime = 0;
  return new Promise((res) => {
    const t = setTimeout(res, 15000);
    v.onended = () => { clearTimeout(t); res(); };
    v.play().catch(() => { clearTimeout(t); res(); });
  });
}

// ---------- 播放器：步骤标记 / 暂停 / 继续 / 只播一段 ----------
function renderChapters(frac) {
  const ch = player.chapters;
  $("#chapters").hidden = !ch.length || blocked();
  const btn = $("#btn-play");
  btn.textContent = player.playing ? "⏸" : "▶";
  btn.title = player.playing ? state.lang.ui.pause : state.lang.ui.play;
  btn.setAttribute("aria-label", btn.title);
  const track = $("#chapter-track");
  if (track.childElementCount !== ch.length) {
    track.innerHTML = "";
    const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    ch.forEach((c, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "seg";
      el.style.flexGrow = Math.max(1, (c.end ?? 1) - (c.start ?? 0)); // 段的宽度按这一步的时长
      el.innerHTML = `<i></i><span>${i + 1}</span>`;
      el.title = `${mmss(c.start ?? 0)} · ${steps()[i]?.action_native || ""}`;
      el.onclick = () => { state.avatar.interrupt(); goto(i); }; // 跳到这一步 / 重播这一步
      track.append(el);
    });
  }
  [...track.children].forEach((el, i) => {
    el.classList.toggle("ready", ch[i].ready !== false);
    el.classList.toggle("done", i < state.step);
    el.classList.toggle("cur", i === state.step);
    el.classList.toggle("in-range", !!player.range && i >= state.step && i <= player.range.to);
    if (i !== state.step) el.firstChild.style.width = "";
    else if (frac !== undefined) el.firstChild.style.width = `${Math.round(frac * 100)}%`;
  });
}

function togglePlay() {
  if (!state.guide || blocked()) return;
  if (!player.playing) return resume();
  state.gen++;
  clearTimeout(player.timer);
  Object.assign(player, { playing: false, after: null, asking: false });
  state.avatar.interrupt();
  waitForUser();
}

// 从暂停的地方继续（被打断的那一步从头重播）
function resume() { goto(Math.min(player.cursor, steps().length), { keepRange: true }); }

// 只播第 from 步到第 to 步（0 起），播完停下。用的是已有的章节，不生成新内容。
function playRange(from, to) {
  player.range = { to };
  goto(from, { keepRange: true });
}

// 用户开始提问（说话 / 打字 / 点按钮）：自动暂停，并记下回答完要继续播放
function pauseForQuestion() {
  if (!state.guide || !lessonActive() || player.asking) return;
  player.asking = true;
  if (player.playing) {
    player.playing = false;
    player.after = { kind: "resume" };
    state.gen++; // 取消“自动播下一步”
    $("#stage-video").pause();
    state.avatar.interrupt();
  }
  renderChapters();
}

// 回答完之后：继续播放 / 只播某几步 / 停在原地
function runAfter() {
  clearTimeout(player.timer);
  const a = player.after;
  player.after = null;
  player.asking = false;
  clearZoom();
  if (!state.guide || !lessonActive()) return;
  if (blocked()) { state.mode = "waiting"; armIdleCut(); return; }
  if (a?.kind === "play") return playRange(a.from, a.to);
  if (a?.kind === "resume") return resume();
  drawOverlay({ target: steps()[state.step]?.button_id });
  waitForUser();
}

// 真实数字人：用户一开口就暂停；说完后如果 Ava 一直没反应（比如只是环境噪音），过一会儿自己继续
function onUserSpeech(kind) {
  clearTimeout(session.timer);        // 用户在说话：先别断开
  if (kind === "end") armIdleCut(12000); // Ava 一直没接话的话，照样待机
  if (!state.guide || !lessonActive()) return;
  clearTimeout(player.timer);
  if (kind === "start") return pauseForQuestion();
  if (player.asking) player.timer = setTimeout(() => { if (player.asking && !free.text && state.mode !== "thinking") runAfter(); }, 9000);
}

// ---------- 放大照片上的某个按钮（看不懂面板上的字时用） ----------
function zoomTo(id) {
  const b = state.guide.buttons.find((x) => x.id === id);
  if (!b) return;
  const s = Math.max(1.5, Math.min(3, 1000 / (Math.max(b.box.w, 40) * 4), 1000 / (Math.max(b.box.h, 40) * 3.5))); // 按钮约占画面宽度的 1/4
  const c = boxCenter(b.box), cx = c.x * 100, cy = c.y * 100; // 按钮中心（百分比），统一换算见 boxes.js
  const tx = Math.min(0, Math.max(100 - 100 * s, 50 - cx * s));                // 把按钮移到画面中间，但不露出黑边
  const ty = Math.min(0, Math.max(100 - 100 * s, 50 - cy * s));
  $("#zoomer").style.transform = `translate(${tx}%, ${ty}%) scale(${s})`;
  $("#label-card").innerHTML = `<b>${esc(b.panel_text)}</b><span>＝</span>${esc(b.name_native)}${b.name_en !== b.name_native ? `<small>${esc(b.name_en)}</small>` : ""}`;
  $("#label-card").hidden = false;
  $("#photo-wrap").classList.add("zoomed");
}

function clearZoom() {
  $("#zoomer").style.transform = "";
  $("#label-card").hidden = true;
  $("#photo-wrap").classList.remove("zoomed");
}

// ---------- 安全提醒 ----------
function showDanger(native, en) {
  $("#danger-title").textContent = state.lang.ui.dangerTitle;
  $("#danger-native").textContent = native;
  $("#danger-en").textContent = en && en !== native ? en : "";
  $("#danger").hidden = false;
}
function hideDanger() { $("#danger").hidden = true; }

function waitForUser() {
  state.mode = "waiting";
  armIdleCut(); // Ava 说完了：没人接话就断开会话待机，用户一有输入再开新会话
  renderChapters();
  const ui = state.lang.ui;
  $("#hint").textContent = `${ui.hint} “${ui.next}” · “${ui.repeat}” · “${ui.what}”`;
  $(".chips").classList.add("waiting");
  if (state.step >= steps().length) $("#action").innerHTML = `✅ ${esc(ui.done)}`;
}

function renderStepList() {
  const ol = $("#step-list");
  ol.innerHTML = "";
  steps().forEach((s, i) => {
    const li = document.createElement("li");
    li.className = i === state.step ? "cur" : "";
    li.innerHTML = `${esc(s.action_native)}<small>${esc(s.action_en)}</small>`;
    li.onclick = () => { state.avatar.interrupt(); goto(i); };
    ol.append(li);
  });
}

function renderSources() {
  const ul = $("#source-list");
  ul.innerHTML = "";
  const list = state.guide.sources || [];
  $("#sources-box").hidden = !list.length;
  for (const s of list) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = s.title || s.url;
    li.append(a);
    if (s.kind === "forum") li.insertAdjacentHTML("beforeend", ' <span class="tag">forum</span>');
    ul.append(li);
  }
}

// ---------- 照片标注 ----------
function drawOverlay({ target = null, answer = null } = {}) {
  const svg = $("#overlay");
  const NS = "http://www.w3.org/2000/svg";
  svg.innerHTML = "";
  const img = $("#stage-img");
  const ar = img.naturalWidth / img.naturalHeight || 1; // viewBox 1000x1000 被非等比拉伸，圆要按比例修正
  for (const b of state.guide.buttons) {
    const r = document.createElementNS(NS, "rect");
    const cls = b.id === answer ? "answer" : b.id === target && !answer ? "target" : "";
    Object.entries({ x: b.box.x, y: b.box.y, width: b.box.w, height: b.box.h, rx: 8 }).forEach(([k, v]) => r.setAttribute(k, v));
    r.setAttribute("class", `btn-box ${cls}`);
    r.dataset.id = b.id;
    const t = document.createElementNS(NS, "title");
    t.textContent = `${b.panel_text} — ${b.name_native}`;
    r.append(t);
    svg.append(r);
  }
  const focus = answer || target;
  const b = state.guide.buttons.find((x) => x.id === focus);
  if (b) {
    const kind = answer ? "answer" : "target";
    const cx = b.box.x + b.box.w / 2, cy = b.box.y + b.box.h / 2;
    const ring = document.createElementNS(NS, "ellipse");
    Object.entries({ cx, cy, rx: Math.max(b.box.w / 2 + 14, 30), ry: Math.max(b.box.h / 2 + 14, 30 * ar) }).forEach(([k, v]) => ring.setAttribute(k, v));
    ring.setAttribute("class", `ring ${kind}`);
    svg.append(ring);
    if (!answer && state.step >= 0) {
      const c = document.createElementNS(NS, "ellipse");
      Object.entries({ cx, cy: Math.max(30 * ar, b.box.y - 30 * ar), rx: 26, ry: 26 * ar }).forEach(([k, v]) => c.setAttribute(k, v));
      c.setAttribute("class", `num-bg ${kind}`);
      svg.append(c);
    }
    placePip(cx, cy);
  } else placePip(-1, -1);
  renderBadge(b, answer);
}

function renderBadge(b, answer) {
  let el = $("#num-badge");
  if (!el) {
    el = document.createElement("div");
    el.id = "num-badge";
    el.style.cssText = "position:absolute;transform:translate(-50%,-50%);font:800 18px/1 system-ui;color:#111;pointer-events:none;z-index:1";
    $("#zoomer").append(el);
  }
  if (!b || answer || state.step < 0) { el.textContent = ""; return; }
  const img = $("#stage-img");
  const ar = img.naturalWidth / img.naturalHeight || 1;
  el.style.left = `${(b.box.x + b.box.w / 2) / 10}%`;
  el.style.top = `${Math.max(30 * ar, b.box.y - 30 * ar) / 10}%`;
  el.textContent = String(state.step + 1);
}

function placePip(cx, cy) {
  let pos = "br";
  if (cx >= 0) pos = (cy > 500 ? "t" : "b") + (cx > 500 ? "l" : "r");
  $("#pip-slot").className = `pip ${pos}`;
}

// ---------- 说话 + 字幕 ----------
async function speakLine(native, en, onFrac) {
  const gen = state.gen;
  const line = (state.lastLine = { native, en, done: false });
  if (state.halted) { state.halted = false; state.haltResume = null; renderHush(); } // Ava 又要说话了：不再是“停下”的状态
  state.mode = "speaking";
  $(".chips").classList.remove("waiting");
  $("#hint").textContent = "";
  setSubs(native, en, 0);
  // 开口之前检查会话：断开了、或剩余时间不够说完这一段 → 先开一个新会话
  await ensureSession(speakMs(native));
  if (gen !== state.gen) return "interrupted"; // 连接期间用户已经做了别的操作
  state.history.push({ role: "assistant", content: native });
  const result = await say(native, (spoken) => {
    setSubs(native, en, spoken);
    onFrac?.(Math.min(1, spoken / Math.max(1, native.length)));
  });
  if (result === "done" || result === "timeout") { setSubs(native, en, native.length); line.done = true; }
  return result;
}

function say(text, onProgress) {
  return state.avatar ? state.avatar.say(text, onProgress) : Promise.resolve("done");
}

function setSubs(native, en, spoken) {
  const n = Math.min(spoken, native.length);
  $("#sub-native").innerHTML = `<span class="said">${esc(native.slice(0, n))}</span><span class="todo">${esc(native.slice(n))}</span>`;
  $("#sub-en").textContent = en && en !== native ? en : "";
  recorder.subs = { native, en: en && en !== native ? en : "" };
}

// Ava 自己组织语言的回答（问按钮、问问题）：字幕跟着说，说完补英文翻译
let free = { text: "", gen: -1 };
function onFreeSpeech(chunk, end) {
  clearTimeout(session.timer);
  if (state.halted) return; // 用户让她停下了：被打断的那句话剩下的片段不管
  if (!lessonActive()) { if (end) { if (state.lastLine) state.lastLine.done = true; armIdleCut(); } return; } // 拍照页：问候语 / 闲聊说完后也待机
  // 讲解词被打断后 Anam 会补发一个空的“说完了”事件：不是 Ava 的回答，别动字幕，也别取消待机
  if (!chunk && !free.text) { if (end && !player.playing) armIdleCut(); return; }
  clearTimeout(player.timer);
  if (free.gen !== state.gen) { free = { text: "", gen: state.gen }; state.mode = "speaking"; $(".chips").classList.remove("waiting"); }
  free.text += chunk;
  setSubs(free.text, "", free.text.length);
  if (!end) return;
  const said = free.text.trim();
  free = { text: "", gen: -1 };
  if (!said) return;
  state.history.push({ role: "assistant", content: said });
  const gen = state.gen;
  if (state.reply.code !== "en") {
    fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: said }) })
      .then((r) => r.json())
      .then(({ en }) => { if ($("#sub-native").textContent === said) setSubs(said, en, said.length); })
      .catch(() => {});
  }
  // 说完后：继续播放 / 只播相关的那几步 / 停在原地（见 runAfter）
  player.timer = setTimeout(() => {
    if (gen !== state.gen || state.mode === "thinking") return;
    runAfter();
  }, 1200);
}

// ------------------------------------------------------------------ 4. 边看边问
// 真实数字人：用户说话 → Ava 的 LLM 理解 → 调用客户端工具（下一步 / 高亮按钮…）或直接回答
function onTool(name, args) {
  switch (name) {
    case "next_step": command("next"); return `Now narrating step ${Math.min(state.step + 1, steps().length)}. Stay silent.`;
    case "previous_step": command("prev"); return `Now narrating step ${state.step + 1}. Stay silent.`;
    case "repeat_step": command("repeat"); return "Repeating. Stay silent.";
    case "go_to_step": {
      const n = Math.max(0, Math.min(Number(args.step) - 1, steps().length - 1));
      state.avatar.interrupt();
      goto(n);
      return `Now narrating step ${n + 1}. Stay silent.`;
    }
    case "highlight_button": {
      const id = args.button_id;
      if (!state.guide.buttons.some((b) => b.id === id)) return `Unknown button id ${id}`;
      pauseForQuestion();
      state.gen++;
      state.focusId = id;
      drawOverlay({ target: steps()[state.step]?.button_id, answer: id });
      zoomTo(id);
      return `Highlighted and zoomed in on ${id}. Explain it in one or two sentences; the video resumes by itself afterwards.`;
    }
    case "pause_video":
      if (player.playing) togglePlay();
      return "Paused. Stay silent.";
    case "resume_video":
      // 等 Ava 把话说完再继续；她什么都不说的话，稍后自己继续
      player.asking = true;
      player.after ||= { kind: "resume" };
      clearTimeout(player.timer);
      player.timer = setTimeout(() => { if (!free.text) runAfter(); }, 1500);
      return "Resuming. Stay silent.";
    case "ask_tutor":
      return askTool(String(args.question || ""));
  }
  return "unknown tool";
}

// /api/ask：只发 tutorial_id + 问题 + 当前在第几步（不发照片，也不发完整说明）
async function ask(question, heard) {
  const r = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tutorial_id: state.guide.id,
      question,
      current_step: Math.max(1, Math.min(state.step + 1, Math.max(1, steps().length))),
      language: state.reply.code, // 当前对话用的语言；服务器会检测这句话的语言并在 reply_language 里返回
      heard_language: heard || undefined, // 语音识别听出来的语言（打字时没有）
    }),
  });
  if (!r.ok) throw new Error(`ask ${r.status}`);
  return r.json();
}

// ---------- 自动语言检测 ----------
// /api/ask 返回 reply_language（用户这句话的语言）。和当前不一样就切过去：
//   · Ava 的声音和听写语言是每个会话定好的，所以断开会话，下一句话开口前会用新语言重新连上；
//   · 讲解内容（步骤、字幕、旁白）在后台换成这种语言的版本，视频共用；
//   · 界面上的按钮、提示仍然是首页选的语言。
// 返回 true 表示语言变了。
async function followLanguage(code) {
  const l = state.cfg.languages.find((x) => x.code === code);
  if (!l || l.code === state.reply.code) return false;
  state.reply = l;
  stopIdleListener();
  if (state.avatar instanceof AnamAvatar) await state.avatar.disconnect();
  else await state.avatar.connect({ lang: l });
  switchGuide(l);
  return true;
}

async function switchGuide(l) {
  const g0 = state.guide;
  if (!g0 || blocked() || g0.language?.code === l.code) return;
  try {
    const r = await fetch("/api/localize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tutorial_id: g0.id, lang: l.code }) });
    if (!r.ok) return;
    const g = await r.json();
    // 等翻译的时候用户可能已经换了讲解或又换了语言
    if (state.guide !== g0 || state.reply.code !== l.code || g.steps?.length !== g0.steps.length) return;
    state.guide = { ...g, demoImage: g0.demoImage, demo: g0.demo };
    state.guideFile = `/guides/${g.id}.json`;
    $("#json-link").href = state.guideFile;
    $("#appliance-name").textContent = g.appliance_native === g.appliance_en ? g.appliance_native : `${g.appliance_native} · ${g.appliance_en}`;
    renderStepList();
    renderChapters();
  } catch (e) { console.warn("switchGuide", e); }
}

// 按 /api/ask 的结果操作画面，并记下回答说完后要做什么
//   danger            → 显示安全提醒，停在原地
//   play（1..N）      → 不会用这台家电：播完整讲解
//   play（a..b）      → 不懂某个功能：只播讲这个功能的那几步
//   zoom              → 看不懂标签：放大照片上的那个按钮
//   answer_only/unsure → 回答完继续播放
function applyAnswer(a) {
  const id = state.guide.buttons.some((b) => b.id === a.highlight_button) ? a.highlight_button : null;
  if (id) state.focusId = id;
  drawOverlay({ target: steps()[state.step]?.button_id, answer: id });
  if (a.zoom && id) zoomTo(id);
  if (a.type === "danger") { showDanger(a.answer_native, a.answer_en); player.after = null; }
  else if (a.type === "play") player.after = { kind: "play", from: a.play_from - 1, to: a.play_to - 1 };
  else if (!a.resume) player.after = null;
}

// Ava（真实数字人）转来的问题：查到答案后把要说的话交还给她，说完由 onFreeSpeech → runAfter 接着播
async function askTool(question) {
  pauseForQuestion();
  clearTimeout(player.timer);
  state.gen++;
  state.mode = "thinking";
  renderListen("thinking");
  let a = null;
  try { a = await ask(question); } catch (e) { console.error(e); }
  state.mode = "idle";
  renderListen(state.avatar.listening ? "on" : "off");
  if (!a) return "The lookup failed. Tell the user you are not sure and suggest the official manual.";
  applyAnswer(a);
  if (await followLanguage(a.reply_language)) {
    // 语言变了：这个会话的声音还是原来的语言，已经断开；用新语言的会话把回答念出来
    const gen = ++state.gen;
    (async () => {
      const result = a.answer_native ? await speakLine(a.answer_native, a.answer_en) : "done";
      if (gen !== state.gen || result === "interrupted") return;
      await sleep(a.zoom ? 1500 : 400);
      if (gen === state.gen) runAfter();
    })();
    return "Stay silent.";
  }
  return `Say exactly this to the user and nothing else: "${a.answer_native}"`;
}

// 打字提问、拍照时写的疑问、演示模式的语音：直接问 /api/ask，由 Ava 照念回答
async function answerQuestion(question, heard) {
  if (!state.guide) return;
  pauseForQuestion();
  state.avatar.interrupt();
  const gen = ++state.gen;
  clearTimeout(player.timer);
  state.mode = "thinking";
  renderListen("thinking");
  let a = null;
  try { a = await ask(question, heard); } catch (e) { console.error(e); }
  if (gen !== state.gen) return;
  state.mode = "idle";
  renderListen(state.avatar.listening ? "on" : "off");
  if (!a) return runAfter();
  if (a.nav) return command({ next: "next", previous: "prev", repeat: "repeat" }[a.nav]);
  applyAnswer(a);
  await followLanguage(a.reply_language); // 用户换了语言：声音和字幕跟着换
  if (gen !== state.gen) return;
  const result = a.answer_native ? await speakLine(a.answer_native, a.answer_en) : "done";
  if (gen !== state.gen || result === "interrupted") return; // 用户又开口了：等下一轮回答
  await sleep(a.zoom ? 1500 : 400);
  if (gen !== state.gen) return;
  runAfter();
}

// 打字输入（以及演示模式的语音识别）：常用指令本地识别，其余走 /api/ask
const QUICK = {
  pause: /^(停|暂停|等一下|等等|别说了|安静|stop|pause|wait|hold on|be quiet|para|espera|alto|silencio|dừng|chờ|im lặng|止めて|ストップ|待って|멈춰|잠깐|그만|arr[êe]te|attends?|توقف|انتظر|रुको|ठहरो|बस|pare|espere)/i,
  resume: /^(继续|接着|播放|continue|go on|resume|play|sigue|continúa|tiếp tục|続けて|계속|continue[zr]?|تابع|जारी|continua)/i,
  next: /下一步|下一个|好了|做好了|完成了|\bnext\b|\bdone\b|siguiente|tiếp|次へ|つぎ|次|다음|suivant|التالي|अगला|próximo/i,
  repeat: /再说|再讲|重复|没听清|再来一遍|\bagain\b|\brepeat\b|otra vez|repite|nói lại|もう一度|もういちど|다시|répète|encore|أعد|फिर से|repete|de novo/i,
  prev: /上一步|上一个|返回|\bback\b|previous|anterior|quay lại|前へ|もどる|이전|précédent|السابق|पिछला/i,
};

function userSays(text, heard) {
  text = String(text || "").trim();
  if (!text || !state.guide || !lessonActive()) return;
  state.history.push({ role: "user", content: text });
  if (text.length <= 14 && !blocked()) for (const [cmd, re] of Object.entries(QUICK)) if (re.test(text)) return command(cmd);
  answerQuestion(text, heard);
}

async function command(cmd, { fromTap = false } = {}) {
  if (!state.guide || blocked() || !cmd) return;
  state.avatar.interrupt();
  if (cmd === "pause") return hush(true);
  if (cmd === "resume") return state.halted ? hush(false) : resume();
  if (cmd === "next") return goto(Math.min(state.step + 1, steps().length));
  if (cmd === "prev") return goto(Math.max(0, state.step - 1));
  if (cmd === "repeat") return goto(state.step);
  if (cmd === "restart") return goto(-1);
  if (cmd === "what") {
    const id = state.focusId || steps()[state.step]?.button_id;
    if (id) return explainButton(id);
    if (fromTap) return userSays(state.lang.ui.what);
  }
}

// 点照片上的按钮：直接用步骤 JSON 里的说明讲解
async function explainButton(id) {
  const b = state.guide.buttons.find((x) => x.id === id);
  if (!b) return;
  pauseForQuestion();
  state.avatar.interrupt();
  const gen = ++state.gen;
  clearTimeout(player.timer);
  state.focusId = id;
  drawOverlay({ target: steps()[state.step]?.button_id, answer: id });
  zoomTo(id);
  const result = await speakLine(`${b.name_native}（${b.panel_text}）：${b.function_native}`, `${b.name_en} (${b.panel_text}): ${b.function_en}`);
  if (gen !== state.gen || result === "interrupted") return;
  await sleep(1200);
  if (gen !== state.gen) return;
  runAfter();
}

// 语音识别的反馈：把听到（识别出）的话原样显示出来，用户能看到自己被听成了什么。
// live = 还没说完 / 还在识别；文字用用户说的语言，前面的小标题用界面语言。
function showHeard(text, live = false) {
  text = String(text || "").trim();
  document.querySelectorAll(".heard").forEach((el) => {
    el.hidden = !text;
    el.classList.toggle("live", live);
    el.innerHTML = text ? `<small>🎙️ ${esc(state.lang.ui.heard)}</small>${esc(text)}` : "";
  });
}

function renderListen(kind) {
  const el = $("#listen");
  const ui = state.lang.ui;
  el.className = "listen " + (kind === "on" ? "on" : kind === "hear" ? "hear" : "");
  $("#listen-text").textContent =
    kind === "on" ? ui.listening : kind === "hear" ? "🎙️ …" : kind === "thinking" ? ui.thinking : kind === "standby" ? `💤 ${ui.standby}` : ui.micOff;
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const stripCues = (s) => s.replace(/\[(happy|warm|playful|curious|supportive|concerned|sad|surprised|angry|distressed|neutral|laughter)\]\s*/gi, "");

// ================================================================== 数字人 Ava（Anam）
// 形象 / 声音 / 对话模型见 persona.js。两个会话阶段：
//   greet  —— 打招呼、陪用户拍照（initialMessage 说问候语）
//   lesson —— system prompt 里有步骤 JSON；导航和高亮通过客户端工具回调本页面
// 固定讲解词用 talk() 让 Ava 照念（保证和字幕、标注同步）；用户提问由 Ava 的 LLM 回答。
class AnamAvatar {
  listening = false;
  speaksGreetingItself = true;
  connected = false;   // 当前有没有活着的会话
  speaking = false;    // Ava 正在出声（固定讲解词或她自己的回答）
  #client = null; #pending = null; #seq = 0; #freeWaiters = []; #connectedAt = 0;
  #tail = false;       // 讲解词刚被我们打断：它剩下的片段还会陆续到，不能当成 Ava 的回答

  // 这个会话已经用了多久（毫秒）
  get ageMs() { return this.connected ? Date.now() - this.#connectedAt : 0; }

  // 开一个新会话（已有会话会先关掉）。每个会话单独计时，所以这也是“续期”的办法。
  async connect({ lang, phase, guideId, quiet = false }) {
    const r = await fetch("/api/session-token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: lang.code, phase, guideId, quiet }),
    });
    const { sessionToken, error } = await r.json();
    if (!sessionToken) throw new Error(error || "no token");
    await this.disconnect();
    this.speaksGreetingItself = phase === "greet" && !quiet;

    const { createClient, AnamEvent } = window.anam;
    const c = (this.#client = createClient(sessionToken));
    const live = () => this.#client === c; // 旧会话迟到的事件一律忽略
    // 客户端工具必须在开始推流前注册
    if (phase === "lesson") {
      for (const name of ["next_step", "previous_step", "repeat_step", "go_to_step", "highlight_button", "pause_video", "resume_video", "ask_tutor"]) {
        c.registerToolCallHandler(name, { onStart: async (p) => this.onTool?.(name, p.arguments || {}) });
      }
    }
    const ready = new Promise((res, rej) => {
      c.addListener(AnamEvent.SESSION_READY, res);
      c.addListener(AnamEvent.CONNECTION_CLOSED, (reason) => {
        rej(new Error(reason));
        if (!live()) return;
        // 不是我们主动断的（比如到了时长上限）：收尾，并告诉页面进入待机
        this.#closed();
        this.onClosed?.(reason);
      });
      setTimeout(() => rej(new Error("timeout")), 25000);
    });
    c.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => live() && $("#avatar").classList.add("has-video"));
    c.addListener(AnamEvent.AUDIO_STREAM_STARTED, (stream) => live() && (recorder.audioStream = stream));
    c.addListener(AnamEvent.MIC_PERMISSION_GRANTED, () => { if (!live()) return; this.listening = true; this.onListenChange?.("on"); });
    c.addListener(AnamEvent.MIC_PERMISSION_DENIED, () => { if (!live()) return; this.listening = false; this.onListenChange?.("off"); });
    c.addListener(AnamEvent.USER_SPEECH_STARTED, () => { if (!live()) return; this.onListenChange?.("hear"); this.onUserSpeech?.("start"); });
    c.addListener(AnamEvent.USER_SPEECH_ENDED, () => { if (!live()) return; this.#tail = false; this.onListenChange?.(this.listening ? "on" : "off"); this.onUserSpeech?.("end"); });
    c.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, (ev) => {
      if (live() && ev.role === "user") {
        // Anam 自己听到的用户的话：一段一段到，按消息 id 拼起来
        this.#heard = (this.#heardId === ev.id ? this.#heard : "") + (ev.content || "");
        this.#heardId = ev.id;
        showHeard(this.#heard, !ev.endOfSpeech);
        return;
      }
      if (!live() || ev.role !== "persona") return;
      const text = stripCues(ev.content || "");
      const end = ev.endOfSpeech || ev.interrupted;
      this.speaking = !end;
      if (!this.#pending && this.#tail) { if (end) this.#tail = false; return; }
      if (this.#pending) {
        // 正在念固定讲解词 → 字幕逐字点亮
        this.#pending.spoken += text.length;
        this.#pending.onProgress?.(this.#pending.spoken);
        $("#avatar").classList.add("speaking");
        if (end) this.#finish(ev.interrupted ? "interrupted" : "done");
      } else {
        // Ava 自己的回答
        $("#avatar").classList.toggle("speaking", !end);
        this.onFreeSpeech?.(text, end);
        if (end) this.#freeWaiters.splice(0).forEach((f) => f());
      }
    });
    c.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, () => live() && this.#finish("interrupted"));
    try {
      await c.streamToVideoElement("avatar-video");
      await ready;
    } catch (e) {
      if (live()) this.#closed();
      try { await c.stopStreaming(); } catch {}
      throw e;
    }
    this.connected = true;
    this.#connectedAt = Date.now();
    if (phase === "greet" && state.cfg.stt) { try { c.muteInputAudio(); } catch {} }
    if (this.listening) this.onListenChange?.("on");
  }

  #heard = ""; #heardId = null;
  // 按住说话时把 Ava 自己的麦克风静音（那句话由我们识别），松开后恢复
  muteMic(on) { try { on ? this.#client?.muteInputAudio() : this.#client?.unmuteInputAudio(); } catch {} }

  // 主动断开会话（Ava 说完了、没人接话）。之后 connect() 会开一个全新的会话。
  async disconnect() {
    const c = this.#client;
    if (!c) return;
    this.#closed(); // 先清掉引用，这样它的 CONNECTION_CLOSED 事件不会被当成意外断开
    try { await c.stopStreaming(); } catch {}
  }

  #closed() {
    this.#client = null;
    this.connected = false;
    this.listening = false;
    this.speaking = false;
    $("#avatar").classList.remove("has-video"); // 换回形象照
    this.#finish("closed");
  }

  // 让 Ava 照念一段话，说完（或被打断）时返回
  say(text, onProgress) {
    this.#finish("replaced");
    if (!this.#client) return Promise.resolve("closed"); // 会话已断开：调用方（speakLine）会先 ensureSession
    this.#tail = false;
    const id = ++this.#seq;
    return new Promise((resolve) => {
      const est = 2500 + text.length * (/[぀-鿿가-힯]/.test(text) ? 260 : 75);
      const timer = setTimeout(() => this.#seq === id && this.#finish("timeout"), est + 4000);
      this.#pending = { resolve, onProgress, spoken: 0, timer };
      this.#client.talk(text).catch(() => this.#finish("error"));
    });
  }

  // 当作用户说的话发给 Ava（打字提问、拍照时的疑问）
  sendText(text) { this.#client?.sendUserMessage(text); }

  waitFreeSpeech(ms) {
    return new Promise((res) => { this.#freeWaiters.push(res); setTimeout(res, ms); });
  }

  interrupt() {
    try { this.#client?.interruptPersona(); } catch {}
    this.speaking = false;
    if (this.#pending) this.#tail = true;
    this.#finish("interrupted");
  }

  #finish(reason) {
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    clearTimeout(p.timer);
    $("#avatar").classList.remove("speaking");
    p.resolve(reason);
  }
}

// 演示数字人：Ava 形象照 + 声波动画 + 浏览器朗读 + 浏览器语音识别（如支持）
class FallbackAvatar {
  listening = false;
  speaksGreetingItself = false;
  #pending = null; #lang = "en"; #rec = null;

  #stt = false;
  async connect({ lang }) {
    this.#lang = lang.code;
    speechSynthesis.getVoices();
    if (this.#stt) return this.onListenChange?.("on");
    if (state.cfg.stt && !this.#rec) {
      // 服务器语音识别（自动识别语言）；自己出声的时候不收音
      this.#stt = await sttStart({
        gate: () => !this.#pending,
        onHear: () => { this.onListenChange?.("hear"); showHeard("…", true); },
        onPartial: (t) => showHeard(t, true),
        onText: (t, heard) => { this.onListenChange?.("on"); heardSpeech(t, heard); },
      });
      if (this.#stt) { this.listening = true; return this.onListenChange?.("on"); }
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || this.#rec) return this.onListenChange?.(this.listening ? "on" : "off");
    const rec = (this.#rec = new SR());
    rec.lang = SR_LANG[lang.code] || lang.code;
    rec.continuous = true;
    rec.onresult = (e) => {
      const t = e.results[e.results.length - 1][0].transcript;
      if (!this.#pending) heardSpeech(t); // 自己说话时不收音
    };
    rec.onstart = () => { this.listening = true; this.onListenChange?.("on"); };
    rec.onend = () => { this.listening = false; this.onListenChange?.("off"); setTimeout(() => { try { rec.start(); } catch {} }, 400); };
    rec.onerror = () => {};
    try { rec.start(); } catch {}
  }

  #audio = null;
  say(text, onProgress) {
    this.interrupt();
    return new Promise((resolve) => {
      // 先用 ElevenLabs 的多语言旁白（服务器缓存同一句话），失败再退回浏览器朗读
      const mine = { resolve };
      this.#pending = mine;
      const a = (this.#audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}`));
      const finish = (reason) => this.#pending === mine && this.#done(reason);
      mine.timer = setTimeout(() => finish("timeout"), 8000 + text.length * 300);
      a.ontimeupdate = () => a.duration && onProgress?.(Math.round((a.currentTime / a.duration) * text.length));
      a.onended = () => finish("done");
      a.onerror = () => { if (this.#pending !== mine) return; clearTimeout(mine.timer); this.#pending = null; this.#browserSay(text, onProgress, resolve); };
      $("#avatar").classList.add("speaking");
      a.play().catch(() => a.onerror());
    });
  }

  #browserSay(text, onProgress, resolve) {
    {
      if (!("speechSynthesis" in window)) return setTimeout(() => resolve("done"), 1500);
      const u = new SpeechSynthesisUtterance(text);
      u.voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(this.#lang)) || null;
      u.lang = u.voice?.lang || this.#lang;
      u.rate = 0.95;
      // 被取消的上一句话，它的 onend / onerror 会晚一点才触发：只认属于这一句的事件，否则会把新的一句提前结束
      const mine = { resolve };
      const finish = (reason) => this.#pending === mine && this.#done(reason);
      mine.timer = setTimeout(() => finish("timeout"), 3000 + text.length * 250);
      this.#pending = mine;
      u.onboundary = (e) => this.#pending === mine && onProgress?.(e.charIndex + (e.charLength || 1));
      u.onend = () => finish("done");
      u.onerror = () => finish("error");
      $("#avatar").classList.add("speaking");
      speechSynthesis.speak(u);
    }
  }

  sendText(text) { this.onUserText?.(text); }

  interrupt() {
    if (!this.#pending) return;
    speechSynthesis.cancel();
    this.#audio?.pause();
    this.#done("interrupted");
  }

  #done(reason) {
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    clearTimeout(p.timer);
    $("#avatar").classList.remove("speaking");
    p.resolve(reason);
  }
}

// ================================================================== 录制讲解视频
const recorder = { on: false, mr: null, chunks: [], raf: 0, audioStream: null, subs: { native: "", en: "" } };

function toggleRecording() { recorder.on ? stopRecording() : startRecording(); }

function startRecording() {
  const img = $("#stage-img");
  const W = 1280, photoH = Math.round(W * img.naturalHeight / img.naturalWidth), subH = 200;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = photoH + subH;
  const ctx = canvas.getContext("2d");
  const video = $("#avatar-video");
  const draw = () => {
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, W, photoH);
    const sx = W / 1000, sy = photoH / 1000;
    for (const el of $("#overlay").querySelectorAll("rect.btn-box")) {
      const cls = el.getAttribute("class");
      if (!/target|answer/.test(cls)) continue;
      ctx.strokeStyle = cls.includes("answer") ? "#e2457a" : "#ffb020";
      ctx.lineWidth = 6 + 4 * Math.sin(performance.now() / 180);
      const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => +el.getAttribute(k));
      ctx.strokeRect(x * sx - 6, y * sy - 6, w * sx + 12, h * sy + 12);
    }
    const pos = $("#pip-slot").className.split(" ")[1] || "br";
    const d = Math.round(W * 0.2), m = 20;
    const px = pos.endsWith("l") ? m : W - d - m, py = pos.startsWith("t") ? m : photoH - d - m;
    ctx.save(); ctx.beginPath(); ctx.arc(px + d / 2, py + d / 2, d / 2, 0, Math.PI * 2); ctx.clip();
    // 形象照来自 Anam 的另一个域名，画到画布上会让录制失败（跨域污染），所以只画实时视频
    if (video.videoWidth) {
      const sw = video.videoWidth, sh = video.videoHeight, s = Math.min(sw, sh);
      ctx.drawImage(video, (sw - s) / 2, (sh - s) / 2, s, s, px, py, d, d);
    } else { ctx.fillStyle = "#2b5e5c"; ctx.fillRect(px, py, d, d); }
    ctx.restore();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(px + d / 2, py + d / 2, d / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#fff"; ctx.font = "600 36px system-ui, sans-serif";
    const y = wrap(ctx, recorder.subs.native, 32, photoH + 52, W - 64, 44, 2);
    ctx.fillStyle = "#ffd27a"; ctx.font = "26px system-ui, sans-serif";
    wrap(ctx, recorder.subs.en, 32, y + 8, W - 64, 32, 2);
    recorder.raf = requestAnimationFrame(draw);
  };
  draw();
  const stream = canvas.captureStream(30);
  recorder.audioStream?.getAudioTracks().forEach((t) => stream.addTrack(t));
  const type = ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  recorder.mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  recorder.chunks = [];
  recorder.mr.ondataavailable = (e) => e.data.size && recorder.chunks.push(e.data);
  recorder.mr.onstop = () => {
    const blob = new Blob(recorder.chunks, { type: recorder.mr.mimeType });
    const a = $("#download");
    a.href = URL.createObjectURL(blob);
    a.download = `lesson-${Date.now()}.${blob.type.includes("mp4") ? "mp4" : "webm"}`;
    a.textContent = `⬇ ${state.lang.ui.save}`;
    a.hidden = false;
  };
  recorder.mr.start(1000);
  recorder.on = true;
  $("#btn-rec").classList.add("on");
  goto(-1);
}

function stopRecording() {
  if (!recorder.on) return;
  recorder.on = false;
  cancelAnimationFrame(recorder.raf);
  if (recorder.mr?.state !== "inactive") recorder.mr.stop();
  $("#btn-rec").classList.remove("on");
}

function wrap(ctx, text, x, y, maxW, lh, maxLines) {
  const cjk = /[぀-鿿가-힯]/.test(text);
  const tokens = cjk ? [...text] : text.split(/(\s+)/);
  let line = "", lines = 0;
  for (const t of tokens) {
    if (ctx.measureText(line + t).width > maxW && line) {
      ctx.fillText(line, x, y); y += lh; line = t.trimStart();
      if (++lines >= maxLines) return y;
    } else line += t;
  }
  if (line) { ctx.fillText(line, x, y); y += lh; }
  return y;
}
