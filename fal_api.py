"""Minimal fal.ai queue client. Inputs are sent as data URIs.

Keys: FAL_KEY, FAL_KEY_2, FAL_KEY_3 ... from the environment or the project's .env.
The first key is used until fal answers "out of credit / not authorised / rate limited";
then the next key takes over (see keyring.py). A job is always polled with the key that submitted it.
"""
import base64, json, mimetypes, os, time
import requests
from keyring import KeyRing, is_key_error, load_dotenv

BASE = "https://queue.fal.run"

load_dotenv()
_ring = None


def _keys():
    global _ring
    if _ring is None:
        _ring = KeyRing("FAL_KEY")
    return _ring


def _h(key=None):
    return {"Authorization": f"Key {key or _keys().current()}", "Content-Type": "application/json"}


def data_uri(path):
    mt = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return f"data:{mt};base64," + base64.b64encode(open(path, "rb").read()).decode()


def submit(model, args):
    ring = _keys()
    while True:
        key = ring.current()
        r = requests.post(f"{BASE}/{model}", headers=_h(key), json=args, timeout=120)
        if r.status_code < 400:
            ring.ok()
            job = r.json()
            job["_key"] = key  # poll with the same key; never written to disk by this module
            return job
        # out of credit / bad key / rate limited on this account -> try the next key
        if is_key_error(r.status_code, r.text) and ring.advance(f"HTTP {r.status_code}"):
            continue
        raise RuntimeError(f"{model} submit {r.status_code}: {r.text[:800]}")


def wait(job, timeout=1800, poll=3, verbose=True):
    t0 = time.time()
    key = job.get("_key")
    while True:
        s = requests.get(job["status_url"], headers=_h(key), timeout=60).json()
        if s.get("status") == "COMPLETED":
            break
        if time.time() - t0 > timeout:
            raise TimeoutError(job["request_id"])
        time.sleep(poll)
    r = requests.get(job["response_url"], headers=_h(key), timeout=120)
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
