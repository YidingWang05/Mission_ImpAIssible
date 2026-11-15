# HomeGuide tonight-demo — agent report (branch `tonight-demo`)

The fal fallback (section 6b) was **not triggered**. fal stayed within budget, so there is no `static_image_explain` branch.

## Starting state (what the repo had)
- `/api/analyze`, `/api/ask`, `/api/session-token`, `/api/translate` were working. `GET /api/render/:id` only returned estimated chapters, and `POST /api/render` did not exist.
- The frontend already had the lesson player: photo, SVG button marks, two subtitle lines, step marks, ask flow, `play_from/play_to` and the danger card. The lesson ran on speech only, with no video.
- The video script's planner was calling Claude through fal, so it was spending fal credit.
- **Data problem:** the root file `appliance-steps-2026-11-14T21-37-34-994Z-536fda.json` is a **Siemens dishwasher (English)**, not the TILLREDA microwave. I ran the real `/api/analyze` on `samples/microwave.jpg` instead (upright; the JPEG has an EXIF rotation tag). The result is the demo guide **`2026-11-15T01-20-02-074Z-75aecb`** (IKEA TILLREDA, Chinese, 6 steps, 3 buttons). It lives in `output/guides/`, which is gitignored and therefore only on this machine.

## 1. What can be demonstrated (section 3)
1. **Choose a language, Ava greets: works.** I checked this headless with Edge: the page loads and the language can be chosen. I did not listen to the audio.
2. **Upload a photo, search keywords shown while waiting: partly works.** It works for a real photo, but the real analysis takes about **2+ minutes**, which is far too long for the stage. The **"🍲 示例：微波炉" sample button** replays the cached analysis in about 2 s, with search keywords shown.
3. **Lesson with step videos, button box, two subtitle lines, step marks, Ava picture-in-picture: works.** The fal clips play step by step. Screenshots show the box exactly on the door button at step 1 and on the top dial at step 4. Both subtitle lines and all 6 marks are present (`output/shots/`).
4. **Asking questions:**
   - "How do I heat food?": **works.** `/api/ask` returns `play_from/play_to` (3–6 or 1–6), the player plays only that range, then asks "还有其他问题吗？".
   - "What is this button?": **partly works.** It circles b1, but Claude classifies it as `function` with a 4–4 play range, so it plays a step instead of giving a one-sentence answer and resuming.
   - Red line (gas question, gas-boiler sample): **works.** The answer is instant, with no tutorial and a contact message.
5. **Continue / next / repeat by step marks: works for chips and clicking marks.** Jumping takes 0.1 s and nothing is regenerated. I did not test voice commands, because the headless browser has no microphone.

**5 consecutive runs:**
- `node tools/smoke.mjs http://localhost:8000 5`: 0 failures. analyze(sample) about 1.8 s, render 4 ms (all cached), ask 1.5–2.6 s, danger 3 ms.
- `py -3 tools/browser_check.py http://localhost:8000 5`: 0 failures. capture→lesson about 2 s, intro→step 1 9–11 s (Ava's intro is spoken first), jump 0.1 s.

## 2. How to start and click through
```
npm install && npm start            # http://localhost:8000
node tools/pregen_demo.mjs          # optional: warms the ElevenLabs cache (already done on this machine)
```
On stage, click: language = 中文 → 开始 → **🍲 示例：微波炉** → the lesson plays → type or say "怎么热饭？" → click a step mark / 下一步 / 再说一遍 → back (←) → **🔥 示例：燃气锅炉** for the red line.

## 3. Endpoints and fields (only additions; no existing fields changed)
- `POST /api/render {tutorial_id}` is now real. It starts `generate_action_videos.py` in the background, steps run 1→2→3, and steps that are already cached are skipped. Generation stops after `RENDER_IDLE_MS` (90 s) without a GET poll.
- Fields added to the render manifest:
  - `mode: "video"`
  - `clips[].duration`
  - `chapters[].est_seconds` (on chapters that are not ready yet)
  - `error`: `fal_budget`, `fal_keys` or `render_failed`
- `status` can be `stopped` on failure.
- `GET /media/<id>/step_NN.mp4` serves the clips.
- `GET /api/narration/:id/:step?lang=en` returns ElevenLabs mp3 of `narration_native` (or `narration_en` with `lang=en`), cached.
- `GET /api/tts?text=` returns ElevenLabs mp3 of any line, cached by sha1(voice+model+text). The fallback avatar (used when Anam is unavailable) now speaks through this, with browser speech as the last resort.
- `/api/analyze` accepts two new `sample` values: `microwave` (the cached demo guide) and `boiler`. Both now also work when keys are set.
- On a real analyze, the photo is stored once at `output/photos/<id>.jpg` for the video factory.
- Shared box conversion (0–1000 → fraction/pixels): `boxes.py` and `public/boxes.js`. The video script's `box_hint`/`closeup` and the frontend's `zoomTo` use it, and the SVG overlay already used a 0–1000 viewBox.
- New env settings, all optional:
  - `RENDER_MODEL` (default `kling21`)
  - `RENDER_IDLE_MS`
  - `PYTHON`
  - `PLANNER_MODEL` (default `claude-sonnet-5-5`)
  - `FAL_BUDGET_USD` (default 12)
  - `ELEVENLABS_VOICE_ID` (default premade "Sarah", because free ElevenLabs keys cannot use library voices; keys 1–2 returned 402 for Rachel and key 3 lacks TTS permission)
  - `DEMO_GUIDE_ID`

## 4. fal spend
- Prices were checked on the fal model pages: Kling 2.1 standard i2v costs $0.28 per 5 s plus $0.056/s; Kling 2.5 turbo pro costs $0.35 per 5 s plus $0.07/s.
- **Total tonight: $2.24 (estimated)**, logged per call in `output/fal_spend.json`, all with Kling 2.1 standard:
  - $0.28 was a debug clip of the mismatched dishwasher guide.
  - $1.96 was the 6 microwave steps (one of them 10 s).
- The planner now calls Claude directly through `claude_api.py` (KeyRing `ANTHROPIC_API_KEY*`), so it costs no fal credit.
- Every fal result is cached, and repeat runs cost $0. `spend.guard` refuses any call that would push the total over $12.
- Remaining: roughly **£30 − ~$2.24 ≈ £28**. The exact balance was not checked on the fal dashboard.

## 5. Known issues and not verified
1. **Fix first on Sunday: "what is this button" plays a step instead of a one-sentence answer plus resume** (`brain.js`/`ASK_SYSTEM` classification).
2. A real photo takes 2+ minutes to analyze, so use the sample button on stage.
3. Not verified:
   - Anam session renewal in the middle of a lesson (I only read the `ensureSession` code).
   - The Anam-down fallback with real audio.
   - The ElevenLabs audio playing in the browser (I verified that the files are produced and cached, but did not listen).
   - Voice commands and the microphone.
   - The idle-stop of rendering (implemented but not exercised).
4. If a question needs a step whose clip is not ready yet, the player shows the photo with the box and the narration instead of waiting for the clip.
5. Not done: task 7 (ElevenLabs realtime voice-only mode) and exposing the video functions as new Anam client tools (the existing tools still drive the same player functions, so the videos follow them).
6. Task 8 is done but only lightly checked: `python tools/export_adaption.py output/guides adaption` writes `train.jsonl`/`eval.jsonl`. There are only 3 usable guides today.
7. Styling is still in `public/style.css` and was not refactored into CSS variables beyond what was already there.
8. The `python` that node finds first on this machine is the main repo's `.venv`, which has no Pillow, so the server auto-detects a working interpreter (`py -3`).
