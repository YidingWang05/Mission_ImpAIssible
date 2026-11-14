"""多密钥轮换（Python 版，规则和 keys.js 一样）。

.env 里同一个服务可以放多个密钥：NAME、NAME_2、NAME_3 …（空的会被跳过）。
先用第一个；只有在额度不足 / 鉴权失败 / 被限流时才换下一个，并记住换到了哪一个。
密钥的值永远不会被打印，日志里只出现“第几个”。

    from keyring import KeyRing, is_key_error
    ring = KeyRing("FAL_KEY")
    key = ring.current()
    ...
    if is_key_error(resp.status_code, resp.text) and ring.advance("HTTP 403"):
        retry with ring.current()
"""
import os
import re
import sys

MAX_KEYS = 9
KEY_STATUS = {401, 402, 403, 429}
KEY_TEXT = re.compile(
    r"credit balance|insufficient|out of credit|quota|exhausted|billing|payment required|balance is too low"
    r"|invalid.{0,12}api.?key|unauthori[sz]ed|authentication|rate.?limit|usage limit|spend cap|user is locked",
    re.I,
)


def load_dotenv(path=None):
    """Read KEY=VALUE lines from .env into os.environ (existing variables win). No dependency needed."""
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


def keys_for(name, env=None):
    env = os.environ if env is None else env
    names = [name] + [f"{name}_{i}" for i in range(2, MAX_KEYS + 1)]
    out = []
    for n in names:
        v = (env.get(n) or "").strip()
        if v and v not in out:
            out.append(v)
    return out


def is_key_error(status=None, text=""):
    """True if switching to another key could fix this failure."""
    return (status in KEY_STATUS) or bool(KEY_TEXT.search(text or ""))


class KeyRing:
    def __init__(self, name, env=None):
        self.name = name
        self.keys = keys_for(name, env)
        self.index = 0
        self.tried = 1

    def __bool__(self):
        return bool(self.keys)

    def current(self):
        if not self.keys:
            raise SystemExit(f"{self.name} is not set")
        return self.keys[self.index]

    def advance(self, reason=""):
        """Move to the next key. Returns False when every key has already been tried."""
        if self.tried >= len(self.keys):
            print(f"[keys] all {len(self.keys)} {self.name} keys are unusable ({reason})", file=sys.stderr, flush=True)
            return False
        nxt = (self.index + 1) % len(self.keys)
        print(f"[keys] {self.name} key {self.index + 1} unusable ({reason}), switching to key {nxt + 1}", file=sys.stderr, flush=True)
        self.index = nxt
        self.tried += 1
        return True

    def ok(self):
        """Call after a success so a later failure gets a full round of retries again."""
        self.tried = 1
