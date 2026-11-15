// Pre-generate (and cache on the server) every ElevenLabs line the stage demo needs.
// Usage: node tools/pregen_demo.mjs [baseUrl] [guideId]   (server must be running)
const base = process.argv[2] || "http://localhost:8000";
const id = process.argv[3] || "2026-11-15T01-20-02-074Z-75aecb";
const get = async (url) => {
  const t = Date.now();
  const r = await fetch(base + url);
  const n = (await r.arrayBuffer()).byteLength;
  console.log(r.status, n, `${Date.now() - t}ms`, url.slice(0, 80));
  if (!r.ok) process.exitCode = 1;
};
const tts = (text) => text && get(`/api/tts?text=${encodeURIComponent(text)}`);

const g = await fetch(`${base}/guides/${id}.json`).then((r) => r.json());
for (const s of g.steps) {
  await get(`/api/narration/${id}/${s.step}`);          // native (e.g. Chinese)
  await get(`/api/narration/${id}/${s.step}?lang=en`);  // second language: English
}
for (const k of ["intro", "closing"]) { await tts(g[`${k}_native`]); await tts(g[`${k}_en`]); }

// red-line sample (gas boiler): the refusal + official contact message, in both languages
const lines = (await fetch(`${base}/api/analyze`, { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sample: "boiler", lang: g.language.code }) }).then((r) => r.text())).trim().split("\n").map((l) => JSON.parse(l));
const b = lines.find((l) => l.type === "result")?.guide;
if (b) for (const k of ["intro", "safety_message"]) { await tts(b[`${k}_native`]); await tts(b[`${k}_en`]); }
