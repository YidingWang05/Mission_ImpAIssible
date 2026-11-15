"""Export guides in output/guides/ to Adaption training data (JSONL). Does NOT call the Adaption API.

input  = English button texts + narration_en for every step
output = simple step-by-step instructions in the user's native language
Writes adaption/train.jsonl and adaption/eval.jsonl (every 5th guide goes to eval).
Usage: python tools/export_adaption.py [guides_dir] [out_dir]
"""
import glob, json, os, sys

src = sys.argv[1] if len(sys.argv) > 1 else os.path.join("output", "guides")
out = sys.argv[2] if len(sys.argv) > 2 else "adaption"
os.makedirs(out, exist_ok=True)
rows = []
for f in sorted(glob.glob(os.path.join(src, "*.json"))):
    g = json.load(open(f, encoding="utf-8"))
    if g.get("safety") == "blocked" or not g.get("steps"):
        continue
    lang = g.get("language", {})
    btn = {b["id"]: b for b in g.get("buttons", [])}
    src_lines = [f"Appliance: {g.get('appliance_en', '')}", "Buttons: " + "; ".join(
        f"{b.get('panel_text', '')} = {b.get('name_en', '')}" for b in btn.values())]
    for s in g["steps"]:
        b = btn.get(s.get("button_id"))
        src_lines.append(f"{s['step']}. {s['narration_en']}" + (f" [button: {b.get('name_en')}]" if b else ""))
    tgt = "\n".join(f"{s['step']}. {s['action_native']}：{s['narration_native']}" for s in g["steps"])
    rows.append({"input": f"Target language: {lang.get('name', '')} ({lang.get('code', '')})\n" + "\n".join(src_lines),
                 "output": tgt, "meta": {"guide_id": g.get("id"), "lang": lang.get("code")}})
tr, ev = [r for i, r in enumerate(rows) if i % 5 != 4], [r for i, r in enumerate(rows) if i % 5 == 4]
for name, part in (("train.jsonl", tr), ("eval.jsonl", ev)):
    with open(os.path.join(out, name), "w", encoding="utf-8") as fh:
        fh.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in part)
print(f"{len(tr)} train, {len(ev)} eval -> {out}/")
