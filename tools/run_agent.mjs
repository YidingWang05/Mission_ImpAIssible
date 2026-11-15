#!/usr/bin/env node
// 无人值守的 Claude 工程师：按一个 .md 文件里的任务，在另一个分支上自动修改本项目。
//
//   npm run agent -- --prompt AGENT_PROMPT.md --branch tonight-demo
//
// 它做什么：
//   1. 给 <branch> 建一个独立的 git 工作区（worktree，在项目旁边的文件夹里），你当前的文件不会被动到；
//   2. 把 .md 里的任务交给 Claude（Claude Agent SDK，自带读写文件、运行命令的能力），让它一直做到完成；
//   3. 用 .env 里的 ANTHROPIC_API_KEY、ANTHROPIC_API_KEY_2、_3 … 轮流付费：
//      当前账户额度用完 / 密钥失效 / 被限流时，自动换下一个密钥，并从同一段对话接着做，不从头来；
//   4. 进度存在 .agent/<branch>.json。中断后（Ctrl+C、断网、所有密钥都用完）重新运行同一条命令就会接着做。
//
// 安全措施：不会 push；不会改 .env；不会把密钥打印到日志。
// 花费：默认没有总上限 —— 一个账户用完就换下一个，直到任务完成或所有密钥都用完。想设上限用 --max-usd。
//
// 选项：
//   --prompt <file>    任务文件（默认 AGENT_PROMPT.md）
//   --branch <name>    要在哪个分支上工作（默认 agent-work；不存在就从 --base 新建）
//   --base <ref>       新分支从哪里分出来（默认：你现在所在的提交）
//   --model <id>       默认 claude-opus-5-5（也可以用环境变量 AGENT_MODEL）
//   --max-usd <n>      所有密钥加起来最多花多少美元（估算值；默认不限）
//   --max-turns <n>    每一轮最多多少步，到了会自动续下一轮（默认 400）
//   --fresh            忘掉上次的进度，开一段新对话（分支上已有的提交会保留）
//   --dry-run          只打印计划，不调用模型、不建工作区
//   --no-supervise     程序自己意外退出时不自动重启（默认会自动重启并接着做）
//
// 任务文件可以在运行期间修改：下一轮开始时会把新版本发给智能体。
// 任务文件里如果要求中途换到另一个分支（例如后备方案），智能体会在同一个工作区里换过去。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { keysFor } from "../keys.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..");

// ---------------------------------------------------------------- 参数
export function parseArgs(argv) {
  const a = { prompt: "AGENT_PROMPT.md", branch: "agent-work", base: "HEAD", model: process.env.AGENT_MODEL || "claude-opus-5-5", maxUsd: Infinity, maxTurns: 400, fresh: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--prompt") a.prompt = next();
    else if (k === "--branch") a.branch = next();
    else if (k === "--base") a.base = next();
    else if (k === "--model") a.model = next();
    else if (k === "--max-usd") a.maxUsd = Number(next());
    else if (k === "--max-turns") a.maxTurns = Number(next());
    else if (k === "--fresh") a.fresh = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--child") a.child = true;
    else if (k === "--no-supervise") a.noSupervise = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new Error(`不认识的参数：${k}`);
  }
  if (!/^[\w./-]+$/.test(a.branch)) throw new Error(`分支名不合法：${a.branch}`);
  if (!(a.maxUsd > 0)) throw new Error("--max-usd 必须大于 0");
  return a;
}

// ---------------------------------------------------------------- git 工作区
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (cwd, ...args) => { try { git(cwd, ...args); return true; } catch { return false; } };

export function prepareWorktree({ branch, base }) {
  const dir = path.join(path.dirname(REPO), `${path.basename(REPO)}-${branch.replace(/[^\w.-]+/g, "_")}`);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(REPO, "worktree", "prune");
    if (gitOk(REPO, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)) git(REPO, "worktree", "add", dir, branch);
    else git(REPO, "worktree", "add", "-b", branch, dir, base);
  }
  // 任务文件可能让智能体中途换分支（后备方案），所以工作区不在 <branch> 上不算错，提示一下接着做
  const on = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  if (on !== branch) console.log(`注意：工作区现在在分支 ${on} 上（不是 ${branch}），按上次停下的地方继续。`);
  // 密钥文件不在 git 里，要单独复制过去；复制前确认它在新工作区里也是被忽略的（这是公开仓库）
  const envSrc = path.join(REPO, ".env");
  if (fs.existsSync(envSrc)) {
    if (!gitOk(dir, "check-ignore", "-q", ".env")) throw new Error(`${dir} 里的 .env 没有被 .gitignore 忽略，为避免泄露密钥已停止。`);
    fs.copyFileSync(envSrc, path.join(dir, ".env"));
  }
  return dir;
}

// ---------------------------------------------------------------- 进度 / 日志
const STATE_DIR = path.join(REPO, ".agent");
const stateFile = (branch) => path.join(STATE_DIR, `${branch.replace(/[^\w.-]+/g, "_")}.json`);

export function loadState(branch) {
  try { return JSON.parse(fs.readFileSync(stateFile(branch), "utf8")); } catch { return { sessionId: null, keyIndex: 0, spentUsd: 0, rounds: 0, done: false }; }
}
function saveState(branch, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFile(branch), JSON.stringify({ ...state, updated_at: new Date().toISOString() }, null, 2));
}

// 日志和屏幕输出里把所有密钥的值抹掉
export function makeScrubber(env) {
  const secrets = Object.entries(env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && String(v).length >= 8).map(([, v]) => String(v));
  return (text) => secrets.reduce((t, s) => t.split(s).join("[secret]"), String(text));
}

// ---------------------------------------------------------------- 给智能体的固定规则（附加在系统提示后面）
const rules = (branch, dir) => `You are running UNATTENDED as this team's engineer. Nobody can answer questions during the run: when something is ambiguous, make the most reasonable choice, keep going, and record the choice in your final report.

Workspace rules:
- Work only inside ${dir}. It is a git worktree checked out on branch "${branch}". Do not touch files outside it, other worktrees, or other branches.
- Commit in small steps on this branch; each commit should leave the app runnable. Never push, never rewrite history, never change git remotes. Stay on this branch unless the task file itself tells you to continue on another branch under some condition; in that case commit first, create that branch from your current commit inside this same directory (git switch -c <name>), and keep working there. Never check out main or any branch the task did not name.
- All API keys are in .env in this directory. Never print them, never copy them into code, logs, commit messages or reports, and never edit .env. This is a public repository.
- A service may have several keys (NAME, NAME_2, NAME_3 ...). Always go through the project's helpers — keys.js (withKey / fetchWithKey) in JavaScript and keyring.py (KeyRing) in Python — so a key that is out of credit is replaced by the next one automatically. Add any new external service the same way.
- Long-running commands (servers, video generation) must be started in the background and stopped when you are done; do not leave a command that waits forever in the foreground.
- If you are truly blocked (a required key is missing, a budget in the task would be exceeded), stop, and say exactly what is blocking you.
- When you finish or have to stop, write the report the task asks for to AGENT_REPORT.md in this directory and commit it. Say plainly what was not done or not verified.`;

// ---------------------------------------------------------------- 护栏：拦掉危险操作（智能体跑在“不逐条确认”模式下）
const DENY_BASH = [
  [/\bgit\s+push\b/i, "pushing is not allowed in this run; commit locally only"],
  [/\bgit\s+remote\s+(add|set-url|remove|rm)\b/i, "changing git remotes is not allowed"],
  [/\bgit\s+(checkout|switch)\s+(-\S+\s+)*(main|master)\b/i, "stay on your own branch"],
  [/\b(cat|type|more|less|head|tail|bat|Get-Content|gc)\b[^|;&]*(^|[\s"'\/\\])\.env(\s|["']|$)/i, "do not print .env; the app and the helpers read it themselves"],
  [/\brm\s+(-\w+\s+)*(\/|~|\$HOME|\.\.)(\s|$)/i, "refusing to delete outside the workspace"],
  [/\b(Remove-Item|rd|rmdir|del)\b.*\s([A-Za-z]:\\?|\\|~|\.\.)(\s|$)/i, "refusing to delete outside the workspace"],
];

export function makeGuard(dir) {
  const root = path.resolve(dir).toLowerCase();
  const tmp = path.resolve(os.tmpdir()).toLowerCase();
  const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
  return async (input) => {
    const t = input.tool_input || {};
    const command = t.command ?? t.script;
    if (typeof command === "string") for (const [re, why] of DENY_BASH) if (re.test(command)) return deny(why);
    const file = t.file_path ?? t.notebook_path;
    if (typeof file === "string" && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name)) {
      const abs = path.resolve(dir, file).toLowerCase();
      if (/(^|[\\/])\.env$/.test(abs)) return deny("do not edit .env");
      if (!abs.startsWith(root + path.sep) && !abs.startsWith(tmp + path.sep)) return deny(`write only inside ${dir}`);
    }
    return {};
  };
}

// ---------------------------------------------------------------- 跑一轮
// 这些错误说明“这个账户不能用了”，换一个密钥就能继续
const KEY_ERRORS = new Set(["authentication_failed", "billing_error", "account_on_hold", "oauth_org_not_allowed", "verification_required", "rate_limit"]);
const KEY_TEXT = /credit balance|balance is too low|billing|insufficient|quota|invalid.{0,12}api.?key|authentication|unauthori[sz]ed|rate.?limit|usage limit|spend(ing)? (cap|limit)|\b(401|402|403|429)\b/i;

// 返回 { outcome: "done" | "key" | "max_turns" | "budget" | "error", detail, costUsd, sessionId }
export async function runRound({ queryFn, prompt, options, onEvent }) {
  let sessionId = options.resume || null, costUsd = 0, keyError = null, lastText = "", result = null;
  try {
    for await (const m of queryFn({ prompt, options })) {
      if (m.session_id) sessionId = m.session_id;
      if (m.type === "assistant") {
        if (m.error && KEY_ERRORS.has(m.error)) keyError = m.error;
        for (const b of m.message?.content || []) {
          if (b.type === "text" && b.text.trim()) { lastText = b.text; onEvent?.("say", b.text); }
          else if (b.type === "tool_use") onEvent?.("tool", `${b.name} ${JSON.stringify(b.input ?? {}).slice(0, 160)}`);
        }
      } else if (m.type === "system" && m.subtype === "api_retry") {
        onEvent?.("note", `API 重试 ${m.attempt}/${m.max_retries}（${m.error}${m.error_status ? ` ${m.error_status}` : ""}）`);
      } else if (m.type === "result") {
        result = m;
        costUsd = m.total_cost_usd || 0;
      }
      onEvent?.("session", sessionId);
    }
  } catch (e) {
    const detail = String(e?.message || e);
    return { outcome: KEY_TEXT.test(detail) ? "key" : "error", detail, costUsd, sessionId };
  }
  const text = [result?.result, ...(result?.errors || []), lastText].filter(Boolean).join(" | ");
  if (keyError) return { outcome: "key", detail: keyError, costUsd, sessionId };
  if (!result) return { outcome: "error", detail: "运行中断，没有收到结果", costUsd, sessionId };
  if (result.subtype === "error_max_turns") return { outcome: "max_turns", detail: "到达本轮步数上限", costUsd, sessionId };
  if (result.subtype === "error_max_budget_usd") return { outcome: "budget", detail: "到达花费上限", costUsd, sessionId };
  if (result.is_error || result.subtype !== "success") return { outcome: KEY_TEXT.test(text) ? "key" : "error", detail: text.slice(0, 300) || result.subtype, costUsd, sessionId };
  return { outcome: "done", detail: String(result.result || "").slice(0, 2000), costUsd, sessionId };
}

// ---------------------------------------------------------------- 主循环：一轮一轮跑，按需换密钥
export async function runAgent({ args, keys, task, dir, queryFn, baseEnv = process.env, log = console.log, onStderr, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let state = args.fresh ? { sessionId: null, keyIndex: 0, spentUsd: 0, rounds: 0, done: false } : loadState(args.branch);
  if (state.done && !args.fresh) { log(`这个分支的任务上次已经完成（.agent 里有记录）。要重新做，加 --fresh。`); return state; }
  let keyIndex = Math.min(state.keyIndex || 0, keys.length - 1);
  let triedSinceProgress = 0; // 连续有多少个密钥失败（中间没有任何进展）
  let softErrors = 0;
  let reason = "";
  const guard = makeGuard(dir);
  const firstPrompt = `Your task is below. Read it fully, then carry it out in this repository.\n\n<task file="${path.basename(args.prompt)}">\n${task}\n</task>`;
  const taskHash = crypto.createHash("sha1").update(task).digest("hex");

  for (let round = 0; round < 60; round++) {
    const capped = Number.isFinite(args.maxUsd);
    const capText = capped ? ` / $${args.maxUsd}` : "（无上限）";
    const left = args.maxUsd - state.spentUsd;
    if (left <= 0.05) { log(`已到花费上限 $${args.maxUsd}（已花约 $${state.spentUsd.toFixed(2)}）。要继续请调大 --max-usd 再运行。`); break; }
    const resuming = Boolean(state.sessionId);
    const prompt = !resuming
      ? (state.rounds ? `${firstPrompt}\n\nNote: an earlier run already worked on this branch but its conversation is not available. Check \`git log\` and the files first, then continue from there instead of starting over.` : firstPrompt)
      : `Continue the task from exactly where you stopped${reason ? ` (the previous run was interrupted: ${reason})` : ""}. Do not redo finished work; check \`git status\` and \`git log\` if unsure.` +
        // 任务文件在两轮之间被改过：把新版本完整发一遍
        (state.taskHash !== taskHash ? `\n\nThe team has UPDATED the task file since you last read it. The full current version is below and replaces the earlier one. Work you already finished stays; follow the new or changed instructions from here on.\n\n<task file="${path.basename(args.prompt)}">\n${task}\n</task>` : "");
    if (resuming && state.taskHash !== taskHash) log("（任务文件有更新，已把新版本发给智能体）");
    state.taskHash = taskHash;
    log(`\n=== 第 ${state.rounds + 1} 轮 · 密钥 ${keyIndex + 1}/${keys.length} · ${resuming ? "接着上次的对话" : "新对话"} · 已花约 $${state.spentUsd.toFixed(2)}${capText} ===`);

    const env = { ...baseEnv, ANTHROPIC_API_KEY: keys[keyIndex] };
    for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]) delete env[k]; // 一定用这个密钥付费，不用本机登录的账户
    const r = await runRound({
      queryFn,
      prompt,
      options: {
        cwd: dir,
        model: args.model,
        env,
        resume: state.sessionId || undefined,
        maxTurns: args.maxTurns,
        ...(capped ? { maxBudgetUsd: Number(left.toFixed(2)) } : {}),
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        systemPrompt: { type: "preset", preset: "claude_code", append: rules(args.branch, dir) },
        hooks: { PreToolUse: [{ hooks: [guard] }] },
        stderr: (text) => onStderr?.(text),
      },
      onEvent: (kind, text) => {
        if (kind === "session") { if (text && text !== state.sessionId) { state.sessionId = text; saveState(args.branch, { ...state, keyIndex }); } }
        else log(kind === "say" ? `\n${text}` : kind === "tool" ? `  · ${text}` : `  (${text})`);
      },
    });

    state = { ...state, sessionId: r.sessionId || state.sessionId, keyIndex, spentUsd: state.spentUsd + (r.costUsd || 0), rounds: state.rounds + 1 };
    saveState(args.branch, state);

    if (r.outcome === "done") { state.done = true; saveState(args.branch, state); log(`\n✅ 完成。${r.detail ? `\n${r.detail}` : ""}`); break; }
    if (r.outcome === "budget") { log(`\n⏹ ${r.detail}。`); break; }
    if (r.outcome === "max_turns") { reason = "turn limit reached"; triedSinceProgress = 0; softErrors = 0; continue; }
    if (r.outcome === "key") {
      // 这一轮在出错前已经做了事，说明这个密钥之前是好的 → 重新给所有密钥一次机会
      if ((r.costUsd || 0) > 0) triedSinceProgress = 0;
      triedSinceProgress++;
      if (triedSinceProgress >= keys.length) { log(`\n⏹ ${keys.length} 个 Claude 密钥都不可用了（${r.detail}）。充值或在 .env 里加新密钥后，重新运行同一条命令会接着做。`); break; }
      const next = (keyIndex + 1) % keys.length;
      log(`\n🔑 密钥 ${keyIndex + 1} 不可用（${r.detail}），换密钥 ${next + 1}，接着同一段对话继续。`);
      keyIndex = next;
      reason = "the API account ran out of credit; a different account is now paying";
      continue;
    }
    // 其他错误：等一会儿再试几次（断网、服务端过载等）
    if (++softErrors > 4) { log(`\n⏹ 连续出错，已停止：${r.detail}`); break; }
    // 续接失败（比如换了电脑，本地没有那段对话）→ 开一段新对话，让它先看 git 记录
    if (resuming && /no conversation found|session.*not found|could not resume/i.test(r.detail)) { state.sessionId = null; saveState(args.branch, state); }
    reason = "a temporary error";
    log(`\n⚠️ 出错：${r.detail}\n   ${softErrors * 20} 秒后重试（第 ${softErrors} 次）。`);
    await sleep(softErrors * 20000);
  }
  return state;
}

// ---------------------------------------------------------------- 入口
// 退出码：0 = 任务完成；3 = 有意停下（密钥全部用完 / 到了花费上限 / 配置有问题），重启也没用；
//        其他 = 程序自己意外退出（崩溃、被系统杀掉）→ 外层的看护进程会自动重启，从存档接着做。
const EXIT_DONE = 0, EXIT_STOP = 3;

// 看护进程：把真正干活的进程当子进程启动，意外退出就重启
async function supervise(argv) {
  const script = fileURLToPath(import.meta.url);
  for (let restarts = 0; ; restarts++) {
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script, ...argv, "--child"], { stdio: "inherit" });
      child.on("exit", (c, signal) => resolve(c ?? (signal ? 1 : 0)));
      child.on("error", () => resolve(1));
    });
    if (code === EXIT_DONE || code === EXIT_STOP) return code;
    if (restarts >= 30) { console.error(`\n❌ 已经自动重启 ${restarts} 次，不再重试（最后的退出码 ${code}）。`); return EXIT_STOP; }
    console.error(`\n⚠️ 运行程序意外退出（退出码 ${code}）。30 秒后自动重启并接着做（第 ${restarts + 1} 次）。`);
    await new Promise((r) => setTimeout(r, 30000));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  if (args.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 30).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")); return; }
  if (!args.child && !args.dryRun && !args.noSupervise) { process.exitCode = await supervise(argv); return; }

  const promptPath = path.resolve(process.cwd(), args.prompt);
  if (!fs.existsSync(promptPath)) throw new Error(`找不到任务文件：${promptPath}`);
  const task = fs.readFileSync(promptPath, "utf8");

  // 只把 .env 读进内存用来取密钥，不改这个进程自己的环境变量
  const envFile = fs.existsSync(path.join(REPO, ".env")) ? dotenv.parse(fs.readFileSync(path.join(REPO, ".env"))) : {};
  const keys = keysFor("ANTHROPIC_API_KEY", { ...process.env, ...envFile });
  const scrub = makeScrubber({ ...envFile, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "" });

  console.log(`任务文件：${promptPath}（${task.length} 字）`);
  console.log(`分支：${args.branch}（从 ${args.base} 分出）  模型：${args.model}`);
  console.log(`Claude 密钥：${keys.length} 个  花费上限：${Number.isFinite(args.maxUsd) ? `$${args.maxUsd}` : "无（用完一个密钥换下一个）"}  每轮步数上限：${args.maxTurns}`);
  if (!keys.length) throw new Error(".env 里的 ANTHROPIC_API_KEY（以及 _2、_3 …）都是空的。填上至少一个再运行。");
  if (args.dryRun) { console.log("（--dry-run：到此为止，没有调用模型，也没有建工作区）"); return; }

  const dir = prepareWorktree(args);
  console.log(`工作区：${dir}`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFile = path.join(STATE_DIR, `${args.branch.replace(/[^\w.-]+/g, "_")}.log`);
  const toFile = (text) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${scrub(text)}\n`); } catch {} };
  const log = (text) => { console.log(scrub(text)); toFile(text); };
  // 意外崩溃时把原因写进日志，再以“非 0 / 非 3”退出，让看护进程重启
  for (const ev of ["uncaughtException", "unhandledRejection"]) {
    process.on(ev, (e) => { toFile(`[crash] ${ev}: ${e?.stack || e}`); console.error(scrub(`\n[crash] ${e?.message || e}`)); process.exit(1); });
  }
  process.on("exit", (code) => toFile(`[exit] code ${code}`));

  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const state = await runAgent({ args, keys, task, dir, queryFn: query, log, onStderr: (t) => toFile(`[stderr] ${String(t).trimEnd()}`) });
  log(`\n本次结束：共 ${state.rounds} 轮，估算花费约 $${state.spentUsd.toFixed(2)}。`);
  log(`查看结果：cd "${dir}"，然后 git log --oneline；报告在 AGENT_REPORT.md。日志：${logFile}`);
  process.exitCode = state.done ? EXIT_DONE : EXIT_STOP;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`\n❌ ${e.message}`); process.exit(EXIT_STOP); });
}
