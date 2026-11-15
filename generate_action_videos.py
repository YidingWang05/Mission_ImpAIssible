#!/usr/bin/env python3
"""
HomeGuide · Step 2 — guide JSON + appliance photo -> one real-action video per step (fal.ai)

For each step, in order:
  1. start frame = the user's photo (step 1) or the LAST frame of the previous
     step's clip, so the appliance state carries over (door opened in step 1 is
     still open when food goes in in step 2, ...)
  2. Claude (direct Anthropic API, ANTHROPIC_API_KEY*) looks at the
     start frame + the step from the JSON and writes an image-to-video prompt
  3. fal image-to-video (Kling 2.5 Turbo Pro by default) animates the photo:
     a real hand presses / turns / opens exactly what the step says
  4. the clip's last frame becomes the next step's start frame

No presenter / narration here (that is Anam's job); clips are silent.

Output (out/):
  step_01.mp4 ... step_NN.mp4, all_steps.mp4, manifest.json, _fal/ (cache + start frames)

Usage:
  export FAL_KEY=...
  python3 generate_action_videos.py --guide input_guide.json --photo input_photo.jpg --out out
  # the run delivered in this session also used:  --trim 7=8.0
"""
import argparse, hashlib, json, os, re, subprocess, sys
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fal_api as F
import claude_api as C
from boxes import box_center
import spend

VIDEO_MODELS = {
    "kling25": "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    "kling21": "fal-ai/kling-video/v2.1/standard/image-to-video",
}
LLM = "anthropic"
LLM_MODEL = os.environ.get("PLANNER_MODEL", "claude-sonnet-5-5")
NEGATIVE = ("blurry, distorted hands, extra fingers, two hands, second hand, transparent door, see-through door, deformed fingers, morphing appliance, changing kitchen, "
            "text, captions, watermark, camera shake, zoom, cut")

PLANNER = """You are planning ONE short image-to-video clip for a step-by-step appliance tutorial.
The attached image is the exact FIRST FRAME of the clip (a real photo of the user's appliance).
Write a prompt for an image-to-video model (Kling) that shows a real person's hand performing ONLY the current step on THIS appliance, as a clear, slow demonstration.

Rules:
- Locked-off static camera. No zoom, no pan, no cuts. Keep the appliance, room and lighting unchanged.
- The appliance must keep EXACTLY its look from the ORIGINAL photo (second image if given, otherwise the first): same door material and colour (e.g. if the door is opaque dark glass, the inside is NOT visible through it when closed), same panel, knobs and markings. State this explicitly in the prompt.
- Realistic behaviour: the interior light is on only while the door is open or while the oven is running; a closed, idle appliance looks exactly like the original photo.
- Exactly one hand, never two; it belongs to one person standing to one side.
- Identify the target control by its look and position in the frame (e.g. "the upper white knob on the right control panel").
- Describe the hand motion precisely: which finger/grip, direction of rotation and where it stops (use the printed marks you can see), or how the door / tray / food moves.
- Describe the visible result (door swings open on its hinge, interior light turns on, turntable rotates, ...).
- If the step has no hand action (e.g. waiting), describe only the appliance's visible behaviour.
- The hand enters, does the action, and leaves the frame; the last second is still.
- Do not perform actions from other steps. No text or captions in the video.
- Prompt: English, at most 90 words.

Choose duration 5 (seconds) for one simple action, 10 for two actions or slow processes.
Return ONLY JSON: {"prompt": "...", "duration": 5 or 10, "end_state": "one sentence: the appliance state at the end of the clip"}"""


def box_hint(guide, b, img_w, img_h):
    bx = b.get("box")
    if not bx:
        return ""
    cx, cy = box_center(bx)
    return f" Its centre is at about {cx:.0%} from the left and {cy:.0%} from the top of the image."


def plan_step(cache, guide, step, frame_uri, prev_end, img_size, orig_uri=None):
    btn = {b["id"]: b for b in guide.get("buttons", [])}
    b = btn.get(step.get("button_id")) if step.get("button_id") else None
    all_steps = "\n".join(f'  {s["step"]}. {s["action_en"]}' for s in guide["steps"])
    target = (f'Target control: "{b["name_en"]}" (panel marking: {b.get("panel_text", "-")}). '
              f'Function: {b["function_en"]}.{box_hint(guide, b, *img_size)}') if b else "Target control: none (no button for this step)."
    ctx = (f'Appliance: {guide.get("brand", "")} {guide.get("model", "")} — {guide["appliance_en"]}\n'
           f'Goal: {guide["goal_en"]}\nAll steps:\n{all_steps}\n\n'
           f'CURRENT STEP {step["step"]}: {step["action_en"]}\nInstruction text: {step["narration_en"]}\n{target}\n'
           f'State at the start of this clip: {prev_end or "as in the photo"}')
    imgs = [frame_uri] + ([orig_uri] if orig_uri and orig_uri != frame_uri else [])
    if len(imgs) > 1:
        ctx += "\n\nImage 1 = first frame of this clip. Image 2 = the ORIGINAL photo (reference for the appliance's true look)."
    args = {"model": LLM_MODEL, "system": PLANNER, "prompt": ctx, "images": imgs, "max_tokens": 2000}
    k = key(LLM, args)
    r = cache.get(k) or cache.put(k, {"output": C.ask(**args)})
    txt = r["output"]
    m = re.search(r"\{.*\}", txt, re.S)
    plan = json.loads(m.group(0))
    plan["duration"] = "10" if str(plan.get("duration")) == "10" else "5"
    return plan


def key(model, args):
    return hashlib.sha1((model + json.dumps(args, sort_keys=True, ensure_ascii=False)).encode()).hexdigest()[:16]


class Cache:
    def __init__(self, d):
        os.makedirs(d, exist_ok=True)
        self.p = os.path.join(d, "cache.json")
        self.data = json.load(open(self.p)) if os.path.exists(self.p) else {}

    def get(self, k):
        return self.data.get(k)

    def put(self, k, v):
        self.data[k] = v
        json.dump(self.data, open(self.p, "w"), indent=1, ensure_ascii=False)
        return v


def prep_frame(src, dst, long_side=1280):
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")  # phone photos: honour EXIF rotation
    s = long_side / max(im.size)
    if s < 1:
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    im.save(dst, quality=92)
    return dst


def last_frame(video, dst):
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-sseof", "-0.15", "-i", video, "-frames:v", "1",
                    "-q:v", "2", dst], check=True)
    return dst


def closeup(guide, step, video, out, img_size, frac=0.42):
    """Static camera => the JSON button box still matches the video. Crop a 3:4 close-up around it."""
    b = {x["id"]: x for x in guide.get("buttons", [])}.get(step.get("button_id"))
    if not b or not b.get("box"):
        return None
    cx, cy = box_center(b["box"])
    vw, vh = map(int, subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                                      "stream=width,height", "-of", "csv=p=0", video],
                                     capture_output=True, text=True).stdout.strip().split(",")[:2])
    cw = int(vw * frac) // 2 * 2
    ch = int(cw * 4 / 3) // 2 * 2
    x0 = min(max(int(cx * vw - cw * 0.55), 0), vw - cw)   # a bit more room on the hand's side
    y0 = min(max(int(cy * vh - ch / 2), 0), vh - ch)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", video, "-vf",
                    f"crop={cw}:{ch}:{x0}:{y0},scale=900:1200:flags=lanczos", "-c:v", "libx264", "-crf", "18",
                    "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", out], check=True)
    return out


def duration(path):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                                capture_output=True, text=True).stdout.strip() or 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--guide", required=True)
    ap.add_argument("--photo", required=True)
    ap.add_argument("--out", default="out")
    ap.add_argument("--model", default="kling25", choices=list(VIDEO_MODELS))
    ap.add_argument("--no-chain", action="store_true", help="start every step from the original photo")
    ap.add_argument("--only", default=None, help="comma list of step numbers (chaining uses cached earlier steps)")
    ap.add_argument("--trim", action="append", default=[], metavar="STEP=SECONDS",
                    help="cut a step's clip at SECONDS (e.g. 7=8.0 when the model adds unwanted motion at the end); "
                         "applied before the last frame is taken for the next step")
    args = ap.parse_args()
    trims = {int(k): float(v) for k, v in (t.split("=") for t in args.trim)}

    guide = json.load(open(args.guide, encoding="utf-8"))
    os.makedirs(args.out, exist_ok=True)
    fdir = os.path.join(args.out, "_fal")
    cache = Cache(fdir)
    model = VIDEO_MODELS[args.model]
    img_size = ImageOps.exif_transpose(Image.open(args.photo)).size
    only = {int(x) for x in args.only.split(",")} if args.only else None

    start = prep_frame(args.photo, os.path.join(fdir, "start_01.jpg"))
    orig_uri = F.data_uri(start)
    prev_end = None
    manifest = {"schema": "homeguide/action-videos@1", "guide_id": guide["id"], "language": guide["language"],
                "appliance_en": guide["appliance_en"], "video_model": model, "planner": f"{LLM} ({LLM_MODEL})",
                "chained": not args.no_chain, "steps": []}
    files = []
    for st in guide["steps"]:
        n = st["step"]
        if args.no_chain:
            start = prep_frame(args.photo, os.path.join(fdir, f"start_{n:02d}.jpg"))
        uri = F.data_uri(start)
        print(f"step {n}: {st['action_en']}", flush=True)
        plan = plan_step(cache, guide, st, uri, prev_end, img_size, orig_uri)
        print(f"  prompt ({plan['duration']}s): {plan['prompt']}", flush=True)
        out = os.path.join(args.out, f"step_{n:02d}.mp4")
        vargs = {"prompt": plan["prompt"], "image_url": uri, "duration": plan["duration"],
                 "negative_prompt": NEGATIVE, "cfg_scale": 0.5}
        k = key(model, vargs)
        if only and n not in only and not cache.get(k):
            print("  (skipped)")
            break
        r = cache.get(k)
        if not r:
            spend.guard(model, int(plan["duration"]))  # raises BudgetExceeded before any money is spent
            job = F.submit(model, vargs)  # charged once submitted -> log it now, even if we get killed while waiting
            spend.record(model, int(plan["duration"]), guide["id"], n)
            r = cache.put(k, F.wait(job, timeout=1800))
        if not os.path.exists(out) or os.path.getsize(out) == 0:
            if n in trims:
                raw = F.download(r["video"]["url"], os.path.join(fdir, f"step_{n:02d}_untrimmed.mp4"))
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw, "-t", str(trims[n]), "-c:v", "libx264",
                                "-crf", "18", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", out], check=True)
            else:
                F.download(r["video"]["url"], out)
        files.append(out)
        manifest["steps"].append({
            "step": n, "file": os.path.basename(out), "duration_s": round(duration(out), 2),
            "button_id": st.get("button_id"), "action_native": st["action_native"], "action_en": st["action_en"],
            "video_prompt": plan["prompt"], "end_state": plan.get("end_state"),
            "start_frame": os.path.relpath(start, args.out), "fal_video_url": r["video"]["url"],
            "trimmed_to_s": trims.get(n)})
        cu = closeup(guide, st, out, out.replace(".mp4", "_closeup.mp4"), img_size)
        if cu:
            manifest["steps"][-1]["closeup_file"] = os.path.basename(cu)
        json.dump(manifest, open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        prev_end = plan.get("end_state")
        if not args.no_chain:
            start = prep_frame(last_frame(out, os.path.join(fdir, f"end_{n:02d}.jpg")),
                               os.path.join(fdir, f"start_{n + 1:02d}.jpg"))

    if len(files) == len(guide["steps"]):
        lst = os.path.join(args.out, "concat.txt")
        with open(lst, "w") as f:
            f.writelines(f"file '{os.path.basename(p)}'\n" for p in files)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                        "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart",
                        os.path.join(args.out, "all_steps.mp4")], check=True)
        os.remove(lst)
        manifest["all_steps"] = "all_steps.mp4"
    json.dump(manifest, open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("done.")


if __name__ == "__main__":
    main()
