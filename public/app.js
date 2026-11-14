// 家电小老师 —— 前端
// 输入：① 家电照片 ② 语言 ③ 用户的疑问
// 流程：Ava 打招呼 → 拍照（+ 可选疑问）→ 服务端识别型号并联网查资料，生成步骤 JSON（只用 ①②）
//      → 讲解：照片标注 + Ava 口型同步讲解 + 双语字幕；Ava 先回答 ③，然后每步停下来等用户说话
const $ = (s) => document.querySelector(s);

const state = {
  cfg: null,
  lang: null,
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

// ------------------------------------------------------------------ 启动
init();
async function init() {
  state.cfg = await fetch("/api/config").then((r) => r.json());
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

  const d = state.cfg.demo;
  if (d.claude || d.avatar) {
    const parts = [];
    if (d.avatar) parts.push("未配置 ANAM_API_KEY：Ava 用形象照 + 浏览器朗读");
    if (d.claude) parts.push("未配置 ANTHROPIC_API_KEY：识别使用示例面板");
    $("#demo-note").textContent = "演示模式 · " + parts.join("；");
    $("#demo-note").hidden = false;
  }
  $("#btn-sample").hidden = !d.claude;

  $("#btn-start").onclick = start;
  $("#photo").onchange = onPhoto;
  $("#btn-analyze").onclick = () => analyze();
  $("#btn-sample").onclick = () => analyze({ sample: true });
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
  const ui = state.lang.ui;
  document.documentElement.lang = code;
  document.documentElement.dir = state.lang.rtl ? "rtl" : "ltr";
  document.querySelectorAll("[data-t]").forEach((el) => { if (ui[el.dataset.t]) el.textContent = ui[el.dataset.t]; });
  document.querySelectorAll("[data-ph]").forEach((el) => (el.placeholder = ui[el.dataset.ph] || ""));
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
  if (!state.avatar.speaksGreetingItself) say(state.lang.greeting);
}

async function connectAvatar(opts) {
  const make = (Cls) => {
    const a = new Cls();
    a.onUserText = onFallbackUserText;
    a.onListenChange = renderListen;
    a.onTool = onTool;
    a.onFreeSpeech = onFreeSpeech;
    return a;
  };
  if (!state.cfg.demo.avatar) {
    const a = state.avatar instanceof AnamAvatar ? state.avatar : make(AnamAvatar);
    try {
      await a.connect({ lang: state.lang, ...opts });
      return a;
    } catch (e) {
      console.warn("数字人连接失败，改用演示数字人", e);
    }
  }
  const f = state.avatar instanceof FallbackAvatar ? state.avatar : make(FallbackAvatar);
  await f.connect({ lang: state.lang });
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
  say(ui.lookingAt);

  try {
    // 只把照片和语言发给识别接口
    const r = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lang: state.lang.code,
        image: sample ? null : state.photo?.base64,
        mediaType: state.photo?.mediaType,
      }),
    });
    let result = null;
    for await (const ev of ndjson(r)) {
      if (ev.type === "search") logResearch(`🔎 ${ui.searching}: ${ev.query}`);
      else if (ev.type === "sources") ev.sources.slice(0, 5).forEach((s) => logResearch(`📄 ${s.title}`));
      else if (ev.type === "error") throw new Error(ev.error);
      else if (ev.type === "result") result = ev;
    }
    if (!result) throw new Error("no result");
    box.classList.add("done");
    state.guide = result.guide;
    state.guideFile = result.file;
    await enterLesson(result.guide.demoImage || state.photo.dataUrl);
  } catch (e) {
    $("#capture-error").textContent = e.message;
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
  drawOverlay({});

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
  state.avatar?.interrupt();
  stopRecording();
  show("screen-capture");
  placeAvatar($("#hero-slot-2"));
  if (state.avatar instanceof AnamAvatar) state.avatar = await connectAvatar({ phase: "greet", quiet: true });
}

const steps = () => state.guide.steps;

async function goto(i) {
  const g = state.guide;
  const gen = ++state.gen;
  state.step = Math.max(-1, Math.min(i, steps().length));
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

  if (state.step === -1) await speakLine(g.intro_native, g.intro_en);
  else if (s) await speakLine(s.narration_native, s.narration_en);
  else await speakLine(g.closing_native, g.closing_en);
  if (gen !== state.gen) return;

  if (state.step < 0) {
    // 开场白之后：先回答用户拍照时提的疑问，再进入第 1 步
    if (state.question) {
      const q = state.question;
      state.question = "";
      await askAvatar(q);
      // 回答过程中会高亮按钮（gen 会变），只要用户没有跳到别的步骤就继续
      if (state.step !== -1 || !$("#screen-lesson").classList.contains("active")) return;
    }
    return goto(0);
  }
  waitForUser();
}

function waitForUser() {
  state.mode = "waiting";
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
    $("#photo-wrap").append(el);
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
async function speakLine(native, en) {
  state.mode = "speaking";
  $(".chips").classList.remove("waiting");
  $("#hint").textContent = "";
  setSubs(native, en, 0);
  state.history.push({ role: "assistant", content: native });
  const result = await say(native, (spoken) => setSubs(native, en, spoken));
  if (result === "done" || result === "timeout") setSubs(native, en, native.length);
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
  if (!$("#screen-lesson").classList.contains("active")) return;
  if (free.gen !== state.gen) { free = { text: "", gen: state.gen }; state.mode = "speaking"; $(".chips").classList.remove("waiting"); }
  free.text += chunk;
  setSubs(free.text, "", free.text.length);
  if (!end) return;
  const said = free.text.trim();
  free = { text: "", gen: -1 };
  if (!said) return;
  state.history.push({ role: "assistant", content: said });
  const gen = state.gen;
  if (state.lang.code !== "en") {
    fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: said }) })
      .then((r) => r.json())
      .then(({ en }) => { if ($("#sub-native").textContent === said) setSubs(said, en, said.length); })
      .catch(() => {});
  }
  // 说完后恢复当前步骤的标注，继续等用户
  setTimeout(() => {
    if (gen !== state.gen || state.mode === "thinking" || state.step < 0) return;
    drawOverlay({ target: steps()[state.step]?.button_id });
    waitForUser();
  }, 1500);
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
      state.gen++;
      state.focusId = id;
      drawOverlay({ target: steps()[state.step]?.button_id, answer: id });
      return `Highlighted ${id} on the photo.`;
    }
  }
  return "unknown tool";
}

// 输入框打字：真实数字人当作用户说的话交给 Ava；演示模式走本地问答
function userSays(text) {
  if (state.avatar instanceof AnamAvatar) {
    state.history.push({ role: "user", content: text });
    state.avatar.interrupt();
    state.avatar.sendText(text);
  } else onFallbackUserText(text);
}

// 讲解开始时回答用户拍照时提的疑问
async function askAvatar(question) {
  if (state.avatar instanceof AnamAvatar) {
    state.avatar.sendText(question);
    await state.avatar.waitFreeSpeech(45000);
  } else await askDemo(question);
}

// 演示数字人：常用指令本地识别，其余走 /api/ask（示例问答）
const QUICK = {
  next: /下一步|下一个|继续|好了|做好了|完成了|\bnext\b|\bcontinue\b|\bdone\b|siguiente|continúa|tiếp|次へ|つぎ|次|다음|suivant|التالي|अगला|próximo|continua/i,
  repeat: /再说|再讲|重复|没听清|再来一遍|\bagain\b|\brepeat\b|otra vez|repite|nói lại|もう一度|もういちど|다시|répète|encore|أعد|फिर से|repete|de novo/i,
  prev: /上一步|上一个|返回|\bback\b|previous|anterior|quay lại|前へ|もどる|이전|précédent|السابق|पिछला/i,
};

function onFallbackUserText(text) {
  text = text.trim();
  if (!text || !state.guide || !$("#screen-lesson").classList.contains("active")) return;
  state.history.push({ role: "user", content: text });
  if (text.length <= 14) for (const [cmd, re] of Object.entries(QUICK)) if (re.test(text)) return command(cmd);
  askDemo(text).then((done) => done && waitForUser());
}

async function command(cmd, { fromTap = false } = {}) {
  if (!state.guide) return;
  state.avatar.interrupt();
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
  state.avatar.interrupt();
  const gen = ++state.gen;
  state.focusId = id;
  drawOverlay({ target: steps()[state.step]?.button_id, answer: id });
  await speakLine(`${b.name_native}（${b.panel_text}）：${b.function_native}`, `${b.name_en} (${b.panel_text}): ${b.function_en}`);
  if (gen !== state.gen) return;
  drawOverlay({ target: steps()[state.step]?.button_id });
  waitForUser();
}

// 返回 true 表示回答完毕、可以继续等待用户
async function askDemo(question) {
  state.avatar.interrupt();
  const gen = ++state.gen;
  state.mode = "thinking";
  renderListen("thinking");
  try {
    const a = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lang: state.lang.code, question, guide: state.guide,
        stepIndex: Math.max(0, Math.min(state.step, steps().length - 1)), focusButtonId: state.focusId,
      }),
    }).then((r) => r.json());
    if (gen !== state.gen) return false;
    state.mode = "idle";
    renderListen(state.avatar.listening ? "on" : "off");
    if (a.intent === "next") { goto(state.step + 1); return false; }
    if (a.intent === "previous") { goto(Math.max(0, state.step - 1)); return false; }
    if (a.intent === "repeat") { goto(state.step); return false; }
    if (a.button_id) state.focusId = a.button_id;
    drawOverlay({ target: steps()[state.step]?.button_id, answer: a.button_id });
    await speakLine(a.reply_native, a.reply_en);
    if (gen !== state.gen) return false;
    drawOverlay({ target: steps()[state.step]?.button_id });
    return true;
  } catch (e) {
    console.error(e);
    state.mode = "idle";
    return true;
  }
}

function renderListen(kind) {
  const el = $("#listen");
  const ui = state.lang.ui;
  el.className = "listen " + (kind === "on" ? "on" : kind === "hear" ? "hear" : "");
  $("#listen-text").textContent =
    kind === "on" ? ui.listening : kind === "hear" ? "🎙️ …" : kind === "thinking" ? ui.thinking : ui.micOff;
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
  #client = null; #pending = null; #seq = 0; #freeWaiters = [];

  async connect({ lang, phase, guideId, quiet = false }) {
    const r = await fetch("/api/session-token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lang: lang.code, phase, guideId }),
    });
    const { sessionToken, error } = await r.json();
    if (!sessionToken) throw new Error(error || "no token");
    if (this.#client) { this.#finish("replaced"); try { await this.#client.stopStreaming(); } catch {} }
    this.speaksGreetingItself = phase === "greet" && !quiet;

    const { createClient, AnamEvent } = window.anam;
    const c = (this.#client = createClient(sessionToken));
    // 客户端工具必须在开始推流前注册
    if (phase === "lesson") {
      for (const name of ["next_step", "previous_step", "repeat_step", "go_to_step", "highlight_button"]) {
        c.registerToolCallHandler(name, { onStart: async (p) => this.onTool?.(name, p.arguments || {}) });
      }
    }
    const ready = new Promise((res, rej) => {
      c.addListener(AnamEvent.SESSION_READY, res);
      c.addListener(AnamEvent.CONNECTION_CLOSED, (reason) => rej(new Error(reason)));
      setTimeout(() => rej(new Error("timeout")), 25000);
    });
    c.addListener(AnamEvent.VIDEO_PLAY_STARTED, () => $("#avatar").classList.add("has-video"));
    c.addListener(AnamEvent.AUDIO_STREAM_STARTED, (stream) => (recorder.audioStream = stream));
    c.addListener(AnamEvent.MIC_PERMISSION_GRANTED, () => { this.listening = true; this.onListenChange?.("on"); });
    c.addListener(AnamEvent.MIC_PERMISSION_DENIED, () => { this.listening = false; this.onListenChange?.("off"); });
    c.addListener(AnamEvent.USER_SPEECH_STARTED, () => this.onListenChange?.("hear"));
    c.addListener(AnamEvent.USER_SPEECH_ENDED, () => this.onListenChange?.(this.listening ? "on" : "off"));
    c.addListener(AnamEvent.MESSAGE_STREAM_EVENT_RECEIVED, (ev) => {
      if (ev.role !== "persona") return;
      const text = stripCues(ev.content || "");
      const end = ev.endOfSpeech || ev.interrupted;
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
    c.addListener(AnamEvent.TALK_STREAM_INTERRUPTED, () => this.#finish("interrupted"));
    await c.streamToVideoElement("avatar-video");
    await ready;
    if (this.listening) this.onListenChange?.("on");
  }

  // 让 Ava 照念一段话，说完（或被打断）时返回
  say(text, onProgress) {
    this.#finish("replaced");
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

  async connect({ lang }) {
    this.#lang = lang.code;
    speechSynthesis.getVoices();
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || this.#rec) return this.onListenChange?.(this.listening ? "on" : "off");
    const rec = (this.#rec = new SR());
    rec.lang = { zh: "zh-CN", en: "en-US", es: "es-ES", vi: "vi-VN", ja: "ja-JP", ko: "ko-KR", fr: "fr-FR", ar: "ar-SA", hi: "hi-IN", pt: "pt-BR" }[lang.code] || lang.code;
    rec.continuous = true;
    rec.onresult = (e) => {
      const t = e.results[e.results.length - 1][0].transcript;
      if (!this.#pending) this.onUserText?.(t); // 自己说话时不收音
    };
    rec.onstart = () => { this.listening = true; this.onListenChange?.("on"); };
    rec.onend = () => { this.listening = false; this.onListenChange?.("off"); setTimeout(() => { try { rec.start(); } catch {} }, 400); };
    rec.onerror = () => {};
    try { rec.start(); } catch {}
  }

  say(text, onProgress) {
    this.interrupt();
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return setTimeout(() => resolve("done"), 1500);
      const u = new SpeechSynthesisUtterance(text);
      u.voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(this.#lang)) || null;
      u.lang = u.voice?.lang || this.#lang;
      u.rate = 0.95;
      const timer = setTimeout(() => this.#done("timeout"), 3000 + text.length * 250);
      this.#pending = { resolve, timer };
      u.onboundary = (e) => onProgress?.(e.charIndex + (e.charLength || 1));
      u.onend = () => this.#done("done");
      u.onerror = () => this.#done("error");
      $("#avatar").classList.add("speaking");
      speechSynthesis.speak(u);
    });
  }

  sendText(text) { this.onUserText?.(text); }

  interrupt() {
    if (!this.#pending) return;
    speechSynthesis.cancel();
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
