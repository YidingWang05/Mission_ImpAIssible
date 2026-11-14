// 多密钥轮换（所有外部服务共用）
//
// .env 里同一个服务可以放多个密钥：NAME、NAME_2、NAME_3 …（空的会被跳过）。
// 规则：先用第一个；只有在“额度不足 / 鉴权失败 / 被限流”时才换下一个，并且记住换到了哪一个，
// 之后的请求直接从这个密钥开始，不再回头去试已经用完的那个。
//
//   import { withKey, fetchWithKey, keysFor } from "./keys.js";
//   const data = await withKey("ELEVENLABS_API_KEY", (key) => callService(key));
//   const res  = await fetchWithKey("FAL_KEY", (key) => fetch(url, { headers: { Authorization: `Key ${key}` } }));
//
// Python 脚本用同样规则的 keyring.py。密钥的值永远不会被打印，日志里只出现“第几个”。

const MAX_KEYS = 9;

// 这个服务配了哪些密钥（按顺序、去重、去空）
export function keysFor(name, env = process.env) {
  const names = [name, ...Array.from({ length: MAX_KEYS - 1 }, (_, i) => `${name}_${i + 2}`)];
  return [...new Set(names.map((n) => String(env[n] ?? "").trim()).filter(Boolean))];
}

// 明确表示“这个密钥不能用了，换下一个”的错误
export class KeyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "KeyError";
    this.status = status;
  }
}

const KEY_STATUS = new Set([401, 402, 403, 429]);
const KEY_TEXT = /credit balance|insufficient|out of credit|quota|exhausted|billing|payment required|balance is too low|invalid.{0,12}api.?key|unauthori[sz]ed|authentication|rate.?limit|usage limit|spend cap/i;

// 这个错误是不是“换个密钥就能好”的那一类
export function isKeyError(e) {
  if (e instanceof KeyError) return true;
  const status = e?.status ?? e?.statusCode ?? e?.response?.status;
  if (KEY_STATUS.has(Number(status))) return true;
  return KEY_TEXT.test(String(e?.message ?? e ?? ""));
}

const cursor = new Map(); // 服务名 → 现在用到第几个密钥（0 起）

export const currentKeyIndex = (name) => cursor.get(name) ?? 0;
export const resetKeys = (name) => (name ? cursor.delete(name) : cursor.clear());

// 用当前密钥执行 fn(key, index)。遇到密钥类错误就换下一个重试；全部试过还不行，抛出最后一个错误。
export async function withKey(name, fn, { env = process.env, log = console.warn } = {}) {
  const keys = keysFor(name, env);
  if (!keys.length) throw new KeyError(`${name} 未配置`, 0);
  const start = Math.min(currentKeyIndex(name), keys.length - 1);
  let last;
  for (let n = 0; n < keys.length; n++) {
    const i = (start + n) % keys.length;
    try {
      const result = await fn(keys[i], i);
      cursor.set(name, i);
      return result;
    } catch (e) {
      if (!isKeyError(e)) throw e;
      last = e;
      const why = String(e?.status ?? "") || String(e?.message ?? e).slice(0, 80);
      if (n < keys.length - 1) log?.(`[keys] ${name} 第 ${i + 1} 个密钥不可用（${why}），换第 ${((i + 1) % keys.length) + 1} 个`);
      else log?.(`[keys] ${name} 的 ${keys.length} 个密钥都不可用（${why}）`);
    }
  }
  throw last;
}

// fetch 版：request(key) 返回 Response。401 / 402 / 403 / 429 视为密钥问题，自动换下一个。
export function fetchWithKey(name, request, options) {
  return withKey(
    name,
    async (key, i) => {
      const res = await request(key, i);
      if (KEY_STATUS.has(res.status)) throw new KeyError(`${name} HTTP ${res.status}`, res.status);
      return res;
    },
    options,
  );
}
