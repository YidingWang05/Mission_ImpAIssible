# HomeGuide · Step 2: guide JSON + photo → per-step action videos (fal)

```bash
export FAL_KEY=...            # never write the key into code
python3 generate_action_videos.py --guide input_guide.json --photo input_photo.jpg --out out
```

How it works (in step order):
1. **Start frame**: step 1 uses the user's photo; each later step uses the **last frame** of the previous step's video, so the door, food and so on carry over (turn this off with `--no-chain`).
2. **Prompt**: `fal-ai/any-llm/vision` (Claude Sonnet 4.5) is given the start frame + the original photo + this step from the JSON, and writes the image-to-video prompt and the duration (5/10 s).
3. **Video**: `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` animates the real photo: a hand presses or turns the control and the appliance responds (`--model kling21` is cheaper).
4. **Close-up**: the camera is fixed, so the JSON button `box` still lines up with the video; steps with a button also get a 3:4 close-up `step_XX_closeup.mp4`.

The videos have no sound and no presenter (the presenter and narration are done with Anam).
`manifest.json` records each step's file, duration, close-up, the prompt used, and the end state.
All fal results are cached in `out/_fal/cache.json`; re-runs do not bill again.
To regenerate just one step: delete that step's `step_XX.mp4` and its entry in `cache.json`, then run again (later steps will also re-chain from it).

Network: the environment must allow `fal.run`, `queue.fal.run`, and `*.fal.media`.
`old_static_version/` is the earlier static-photo + presenter version, kept for reference only.
