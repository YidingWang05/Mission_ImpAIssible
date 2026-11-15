"""Headless browser walk-through of the stage route (Playwright + system Edge).
Usage: py -3 tools/browser_check.py [baseUrl] [runs]   -> screenshots in output/shots/
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
runs = int(sys.argv[2]) if len(sys.argv) > 2 else 1
os.makedirs("output/shots", exist_ok=True)
fails = 0
with sync_playwright() as p:
    br = p.chromium.launch(channel="msedge", headless=True, args=[
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    for run in range(1, runs + 1):
        page = br.new_page(viewport={"width": 1280, "height": 900})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        t = {}
        try:
            t0 = time.time(); page.goto(base); page.select_option("#lang", "zh"); page.click("#btn-start")
            page.wait_for_selector("#screen-capture.active", timeout=30000); t["welcome->capture"] = time.time() - t0
            t0 = time.time(); page.click("#btn-sample")
            page.wait_for_selector("#screen-lesson.active", timeout=60000); t["sample->lesson"] = time.time() - t0
            t0 = time.time(); page.wait_for_function("document.querySelector('#step-chip').textContent.length > 0", timeout=90000)
            t["intro->step1"] = time.time() - t0
            page.wait_for_timeout(2500)
            info = page.evaluate("""() => ({
              native: document.querySelector('#sub-native').textContent, en: document.querySelector('#sub-en').textContent,
              marks: document.querySelectorAll('#chapter-track button').length,
              video: !document.querySelector('#stage-video').hidden && document.querySelector('#stage-video').src,
              overlay: document.querySelector('#overlay').innerHTML.length })""")
            page.screenshot(path=f"output/shots/run{run}_step1.png")
            t0 = time.time(); page.click("#chapter-track button >> nth=3")
            page.wait_for_function("document.querySelector('#step-chip').textContent.includes('4')", timeout=15000)
            t["jump->step4"] = time.time() - t0
            page.wait_for_timeout(2500); page.screenshot(path=f"output/shots/run{run}_step4.png")
            t0 = time.time(); page.fill("#ask", "怎么热饭？"); page.press("#ask", "Enter")
            page.wait_for_timeout(6000); t["ask(howto)"] = time.time() - t0
            page.screenshot(path=f"output/shots/run{run}_ask.png")
            ok = info["native"] and info["en"] and info["marks"] == 6 and info["overlay"] > 0 and not errs
            fails += not ok
            print(f"run {run}: {'OK' if ok else 'BAD'} marks={info['marks']} video={bool(info['video'])} subs=({info['native'][:20]}|{info['en'][:30]}) "
                  + " ".join(f"{k}={v:.1f}s" for k, v in t.items()) + (f" errors={errs}" if errs else ""))
        except Exception as e:
            fails += 1
            page.screenshot(path=f"output/shots/run{run}_fail.png")
            print(f"run {run}: FAIL {str(e)[:200]} {t} errors={errs}")
        page.close()
    br.close()
print("failures:", fails)
