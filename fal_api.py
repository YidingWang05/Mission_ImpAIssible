"""Minimal fal.ai queue client (reads FAL_KEY from env). Inputs are sent as data URIs."""
import base64, json, mimetypes, os, time
import requests

BASE = "https://queue.fal.run"


def _h():
    key = os.environ.get("FAL_KEY")
    if not key:
        raise SystemExit("FAL_KEY is not set")
    return {"Authorization": f"Key {key}", "Content-Type": "application/json"}


def data_uri(path):
    mt = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return f"data:{mt};base64," + base64.b64encode(open(path, "rb").read()).decode()


def submit(model, args):
    r = requests.post(f"{BASE}/{model}", headers=_h(), json=args, timeout=120)
    if r.status_code >= 400:
        raise RuntimeError(f"{model} submit {r.status_code}: {r.text[:800]}")
    return r.json()


def wait(job, timeout=1800, poll=3, verbose=True):
    t0 = time.time()
    while True:
        s = requests.get(job["status_url"], headers=_h(), timeout=60).json()
        if s.get("status") == "COMPLETED":
            break
        if time.time() - t0 > timeout:
            raise TimeoutError(job["request_id"])
        time.sleep(poll)
    r = requests.get(job["response_url"], headers=_h(), timeout=120)
    if r.status_code >= 400:
        raise RuntimeError(f"result {r.status_code}: {r.text[:800]}")
    if verbose:
        print(f"    fal {job['request_id'][:8]} done in {time.time() - t0:.0f}s", flush=True)
    return r.json()


def run(model, args, **kw):
    return wait(submit(model, args), **kw)


def download(url, path):
    with requests.get(url, stream=True, timeout=300) as r:
        r.raise_for_status()
        with open(path, "wb") as f:
            for c in r.iter_content(1 << 16):
                f.write(c)
    return path
