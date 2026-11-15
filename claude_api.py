"""Tiny Anthropic Messages client for the video planner (uses ANTHROPIC_API_KEY, _2, ... via KeyRing)."""
import time
import requests
from keyring import KeyRing, is_key_error, load_dotenv

load_dotenv()
_ring = None


def ask(model, system, prompt, images=(), max_tokens=600):
    global _ring
    _ring = _ring or KeyRing("ANTHROPIC_API_KEY")
    content = []
    for uri in images:
        head, data = uri.split(",", 1)
        content.append({"type": "image", "source": {"type": "base64", "media_type": head[5:].split(";")[0], "data": data}})
    content.append({"type": "text", "text": prompt})
    body = {"model": model, "max_tokens": max_tokens, "system": system, "messages": [{"role": "user", "content": content}]}
    while True:
        key = _ring.current()
        for attempt in range(4):  # transient network errors: retry, don't switch keys
            try:
                r = requests.post("https://api.anthropic.com/v1/messages", json=body, timeout=180,
                                  headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
                break
            except requests.exceptions.RequestException:
                if attempt == 3:
                    raise
                time.sleep(2 + 3 * attempt)
        if r.status_code in (429, 500, 502, 503, 529) and not is_key_error(r.status_code, r.text):
            time.sleep(5)
            continue
        if r.status_code < 400:
            _ring.ok()
            j = r.json()
            txt = "".join(b.get("text", "") for b in j["content"] if b["type"] == "text")
            if not txt.strip():
                raise RuntimeError(f"claude returned no text (stop_reason={j.get('stop_reason')}, blocks={[b['type'] for b in j['content']]})")
            return txt
        if is_key_error(r.status_code, r.text) and _ring.advance(f"HTTP {r.status_code}"):
            continue
        raise RuntimeError(f"claude {r.status_code}: {r.text[:500]}")
