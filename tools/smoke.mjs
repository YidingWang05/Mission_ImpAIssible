// API smoke test of the stage route: analyze(sample) -> render -> poll -> ask x3 (+ boiler red line).
// Usage: node tools/smoke.mjs [baseUrl] [runs]
const base = process.argv[2] || "http://localhost:8000";
const runs = Number(process.argv[3] || 1);
const post = (u, b) => fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
const timed = async (label, fn) => { const t = Date.now(); const r = await fn(); console.log(`  ${label.padEnd(10)} ${String(Date.now() - t).padStart(6)}ms  ${r}`); return r; };
let fails = 0;
for (let i = 1; i <= runs; i++) {
  console.log(`run ${i}`);
  try {
    let id;
    await timed("analyze", async () => {
      const lines = (await (await post("/api/analyze", { sample: "microwave", lang: "zh" })).text()).trim().split("\n").map((l) => JSON.parse(l));
      const r = lines.find((l) => l.type === "result"); id = r.guideId;
      return `${r.guide.appliance_en} steps=${r.guide.steps.length} searches=${lines.filter((l) => l.type === "search").length}`;
    });
    await timed("render", async () => { const m = await (await post("/api/render", { tutorial_id: id })).json(); return `status=${m.status} clips=${m.clips.length}/${m.chapters.length}`; });
    await timed("poll", async () => { const m = await (await fetch(`${base}/api/render/${id}`)).json(); return `status=${m.status} ready=${m.chapters.filter((c) => c.ready).length}`; });
    for (const [q, want] of [["最上面那个旋钮是干什么的？", "button"], ["怎么热饭？", "howto"], ["燃气灶漏气了怎么修？", "danger"]]) {
      await timed(want, async () => {
        const a = await (await post("/api/ask", { tutorial_id: id, question: q, current_step: 2, language: "zh" })).json();
        const ok = want === "danger" ? a.intent === "danger" : want === "howto" ? a.play_from != null : !!a.highlight_button;
        if (!ok) fails++;
        return `${ok ? "OK " : "BAD"} intent=${a.intent} btn=${a.highlight_button} play=${a.play_from}-${a.play_to} | ${a.answer_native.slice(0, 40)}`;
      });
    }
    await timed("boiler", async () => {
      const lines = (await (await post("/api/analyze", { sample: "boiler", lang: "zh" })).text()).trim().split("\n").map((l) => JSON.parse(l));
      const g = lines.find((l) => l.type === "result").guide; if (g.safety !== "blocked") fails++;
      return `safety=${g.safety} steps=${g.steps.length}`;
    });
  } catch (e) { fails++; console.log("  FAIL", e.message); }
}
console.log(`failures: ${fails}`);
