#!/usr/bin/env node
/**
 * cc-notify — Claude Code PTY wrapper + 飞书远程控制
 *
 * 用法（全局安装后）：
 *   claude-n [claude CLI 参数...]
 *
 * 多实例逻辑：
 *   - 第一个 claude-n 检测到 broker 未运行 → fork broker → 注册自己
 *   - 后续 claude-n 检测到 broker 已运行 → 直接注册自己
 *   - 退出时注销；若自己是最后一个 → 通知 broker 关闭
 *
 * 配置文件查找顺序：
 *   1. ~/.config/cc-notify/.env
 *   2. cwd/.env
 */

import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { spawn } from "child_process";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// --debug 必须在 logger 加载前处理，否则 logger 模块读不到环境变量
const debugIdx = process.argv.indexOf("--debug");
if (debugIdx !== -1) {
  process.env.CC_NOTIFY_DEBUG = "1";
  process.argv.splice(debugIdx, 1);
}

const { ClaudeRuntime } = await import("./claude-runtime.js");
const { logger, LOG_FILE } = await import("./logger.js");
const { connectBroker, isBrokerRunning, onMessages, send, BROKER_SOCK } =
  await import("./ipc.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载 ─────────────────────────────────────────────────────────────────

const userEnv = path.join(homedir(), ".config", "cc-notify", ".env");
const cwdEnv = path.join(process.cwd(), ".env");
if (existsSync(userEnv)) loadDotenv({ path: userEnv });
else if (existsSync(cwdEnv)) loadDotenv({ path: cwdEnv });

// ── 环境变量校验 ──────────────────────────────────────────────────────────────

const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_NOTIFY_CHAT_ID } = process.env;

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
  console.error(
    "[claude-n] 缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET，请检查 .env",
  );
  process.exit(1);
}
if (!FEISHU_NOTIFY_CHAT_ID) {
  console.error("[claude-n] 缺少 FEISHU_NOTIFY_CHAT_ID，请检查 .env");
  process.exit(1);
}

// ── Session ID ────────────────────────────────────────────────────────────────

const SESSION_ID = crypto.randomBytes(2).toString("hex"); // e.g. "a3f2"

// ── Hook 安装/卸载 ────────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(homedir(), ".claude", "settings.json");
const HOOK_CMD = "claude-n-hook"; // 由 package.json#bin 暴露的稳定命令名
const CC_NOTIFY_HOOK = { type: "command", command: HOOK_CMD };

/** 判断某个 hook 是否属于 cc-notify（含当前命令名 + 旧版绝对路径残留） */
function isCcNotifyHook(h) {
  const cmd = h?.command ?? "";
  if (cmd === HOOK_CMD) return true;
  if (/(^|\s|\/)cc-notify(\/|\s)/.test(cmd)) return true; // 旧版绝对路径
  if (/(^|\s|\/)hook\.js(\s|$)/.test(cmd) && /cc-notify/.test(cmd)) return true;
  return false;
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 4));
}

/** `claude-n install` — 把 hook 写进 ~/.claude/settings.json（幂等） */
function installHooks() {
  const settings = readSettings();
  const hooks = { ...(settings.hooks ?? {}) };
  const changes = [];

  // 清掉所有旧版 cc-notify hook（避免重复 + 旧绝对路径残留）
  for (const event of Object.keys(hooks)) {
    const before = JSON.stringify(hooks[event]);
    hooks[event] = (hooks[event] ?? [])
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter((h) => !isCcNotifyHook(h)),
      }))
      .filter((g) => g.hooks.length > 0);
    if (hooks[event].length === 0) delete hooks[event];
    if (JSON.stringify(hooks[event] ?? []) !== before)
      changes.push(`清理旧版 ${event}`);
  }

  // 注入 Notification 和 Stop
  for (const event of ["Notification", "Stop"]) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [CC_NOTIFY_HOOK] }];
    changes.push(`安装 ${event} → ${HOOK_CMD}`);
  }

  writeSettings({ ...settings, hooks });
  console.log(`✅ cc-notify hooks 已安装到 ${SETTINGS_PATH}`);
  for (const c of changes) console.log(`   • ${c}`);
  console.log(`\n下一步：直接运行  claude-n  即可。`);
}

/** `claude-n uninstall` — 从 settings.json 移除所有 cc-notify hook */
function uninstallHooks() {
  const settings = readSettings();
  if (!settings.hooks) {
    console.log("ℹ️  settings.json 中没有 hooks 配置，无需清理");
    return;
  }
  const hooks = { ...settings.hooks };
  let removed = 0;

  for (const event of Object.keys(hooks)) {
    const beforeCount = (hooks[event] ?? []).reduce(
      (n, g) => n + (g.hooks ?? []).length,
      0,
    );
    hooks[event] = (hooks[event] ?? [])
      .map((g) => ({
        ...g,
        hooks: (g.hooks ?? []).filter((h) => !isCcNotifyHook(h)),
      }))
      .filter((g) => g.hooks.length > 0);
    const afterCount = (hooks[event] ?? []).reduce(
      (n, g) => n + (g.hooks ?? []).length,
      0,
    );
    removed += beforeCount - afterCount;
    if (hooks[event].length === 0) delete hooks[event];
  }

  writeSettings({ ...settings, hooks });
  if (removed > 0)
    console.log(`✅ 已从 ${SETTINGS_PATH} 移除 ${removed} 个 cc-notify hook`);
  else console.log(`ℹ️  没有找到 cc-notify hook，无需清理`);
}

/** 启动前检查：hook 是否已安装 */
function isHookInstalled() {
  const settings = readSettings();
  const notif = settings.hooks?.Notification ?? [];
  return notif.some((g) => (g.hooks ?? []).some((h) => h.command === HOOK_CMD));
}

// ── Broker 启动 & 注册 ────────────────────────────────────────────────────────

async function startBroker() {
  logger.info(`[claude-n:${SESSION_ID}] broker 未运行，正在启动...`);
  const brokerPath = path.resolve(__dirname, "broker.js");
  const child = spawn(process.execPath, [brokerPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  // 等 broker 起来（最多 5 秒）
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isBrokerRunning()) return;
  }
  throw new Error("broker 启动超时");
}

async function registerToBroker() {
  const socket = await connectBroker();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("注册超时")), 5_000);
    let ready = false;

    onMessages(socket, (msg) => {
      if (msg.type === "registered") {
        clearTimeout(timer);
        ready = true;
        resolve();
        return;
      }
      if (!ready) return;
      if (msg.type === "select") runtime.select(msg.choice);
      else if (msg.type === "stop") runtime.stop();
      else if (msg.type === "hook_fwd") {
        // 等待 PTY 把权限确认 UI 渲染完再读 buffer，避免竞态。
        // 固定 150ms 经常不够（Ink 重渲染受 CPU 抖动影响），改成轮询：
        // 每 80ms 检查一次，解析到 options 立即发；最多等 1s 后兜底发空 options 卡片。
        (async () => {
          const startTs = Date.now();
          const DEADLINE = startTs + 3_000;
          let options = [];
          let promptText = "";
          let pollCount = 0;
          logger.info(
            `[TRACE][claude-n:${SESSION_ID}] hook_fwd 收到: event=${msg.event?.hook_event_name}, 开始 PTY 轮询`,
          );
          while (Date.now() < DEADLINE) {
            await new Promise((r) => setTimeout(r, 80));
            pollCount++;
            const buf = runtime.getRecentLogs(30);
            options = extractOptions(buf);
            promptText = extractPromptContent(stripAnsi(buf));
            if (options.length > 0) {
              logger.info(
                `[TRACE][claude-n:${SESSION_ID}] PTY 轮询第 ${pollCount} 次命中 options(${options.length})，耗时 ${Date.now() - startTs}ms`,
              );
              break;
            }
          }
          if (options.length === 0) {
            const rawBuf = runtime.getRecentLogs(60);
            logger.info(
              `[TRACE][claude-n:${SESSION_ID}] PTY 轮询超时(3s, ${pollCount}次)，未找到 options，发兜底空卡片\n` +
              `--- stripped buffer (last 60 lines) ---\n${stripAnsi(rawBuf)}\n--- end buffer ---`,
            );
          }
          if (options.length > 0) runtime.setOptions(options);
          logger.info(
            `[TRACE][claude-n:${SESSION_ID}] hook_result 发送: options=${JSON.stringify(options.map((o) => o.value + "=" + o.label))} promptText_len=${promptText.length}`,
          );
          send(socket, {
            type: "hook_result",
            event: { ...msg.event, options, promptText },
          });
        })();
      }
    });

    send(socket, {
      type: "register",
      sessionId: SESSION_ID,
      cwd: process.cwd(),
      pid: process.pid,
    });
  });

  socket.on("close", () => {
    logger.info(`[claude-n:${SESSION_ID}] 与 broker 的连接断开`);
  });

  return socket;
}

// ── Hook 事件处理（本地解析后转发给 broker） ──────────────────────────────────

const BOX_CHARS_RE = /[│╭╰╮╯─╴╸╺╌╍╎╏═║╔╗╚╝╠╣╦╩╬┄┆┇┈┉┊┋┌┐└┘├┤┬┴┼]/g;

function stripAnsi(str) {
  let col = 1,
    out = "",
    i = 0;
  while (i < str.length) {
    if (str[i] === "\x1b") {
      const next = str[i + 1];
      if (next === "]") {
        let j = i + 2;
        while (
          j < str.length &&
          str[j] !== "\x07" &&
          !(str[j] === "\x1b" && str[j + 1] === "\\")
        )
          j++;
        i = str[j] === "\x07" ? j + 1 : j + 2;
      } else if (next === "[") {
        let j = i + 2;
        while (j < str.length && !/[A-Za-z~]/.test(str[j])) j++;
        const param = str.slice(i + 2, j),
          cmd = str[j] ?? "";
        if (cmd === "C") {
          const n = parseInt(param) || 1;
          out += " ".repeat(n);
          col += n;
        } else if (cmd === "G") {
          const n = parseInt(param) || 1;
          if (n > col) out += " ".repeat(n - col);
          col = n;
        } else if ("ABHf".includes(cmd)) {
          out += "\n";
          col = 1;
        }
        i = j + 1;
      } else {
        i += 2;
      }
    } else if (str[i] === "\r") {
      out += "\n";
      col = 1;
      i++;
    } else {
      out += str[i];
      col++;
      i++;
    }
  }
  return out;
}

function isNoiseLine(t) {
  if (!t || t.length >= 20) return false;
  return !/[A-Za-z0-9一-鿿]/.test(t);
}

function extractPromptContent(strippedText) {
  const lines = strippedText.split("\n");
  let cutIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(BOX_CHARS_RE, "").trim();
    const wc = t.replace(/^❯\s*/, "");
    if (/^\d+[.)]\s*\S/.test(wc) || /^Esc\s*to\s*cancel/i.test(t)) {
      cutIdx = i;
      break;
    }
  }
  const cleaned = [];
  let blankRun = 0;
  for (const raw of lines.slice(0, cutIdx)) {
    const line = raw.replace(BOX_CHARS_RE, "").trimEnd();
    const t = line.trim();
    if (/^[\s\d✶✽✸✺✳⏺•◆◇○●✓✗⚡🔄]*(thinking)?[\s\d]*$/.test(t) && t) continue;
    if (/\bthinking\b/.test(t)) continue;
    if (/\btokens?\b/i.test(t)) continue;
    if (/esc\s+to\s+interrupt/i.test(t)) continue;
    if (/seasoning\.\.\./i.test(t)) continue;
    if (/^[-=]{4,}$/.test(t) || t.startsWith("\x1b") || isNoiseLine(t))
      continue;
    if (!t) {
      if (++blankRun <= 1) cleaned.push("");
    } else {
      blankRun = 0;
      cleaned.push(line);
    }
  }
  return cleaned.join("\n").trim();
}

function extractOptions(text) {
  const clean = stripAnsi(text);
  const lines = clean.split("\n");
  const options = [];
  let cursorIndex = 0;
  for (const line of lines) {
    const s = line.replace(BOX_CHARS_RE, "").trim();
    const hasCursor = s.includes("❯");
    const wc = s.replace(/❯\s*/g, "");
    const m = wc.match(/^(\d+)[.)]\s*(.+)$/);
    if (m) {
      if (hasCursor) cursorIndex = options.length;
      options.push({
        value: m[1],
        label: m[2].replace(BOX_CHARS_RE, "").trim().slice(0, 60),
      });
    }
  }
  if (options.length > 0)
    return options.map((o, i) => ({ ...o, arrowsDown: i - cursorIndex }));
  if (/\[y[/\/]n\]/i.test(clean) || /\(y[/\/]n\)/i.test(clean))
    return [
      { value: "y", label: "Yes", arrowsDown: null },
      { value: "n", label: "No", arrowsDown: null },
    ];
  if (/\ballow\b/i.test(clean) && /\bdeny\b/i.test(clean))
    return [
      { value: "y", label: "Allow", arrowsDown: null },
      { value: "n", label: "Deny", arrowsDown: null },
    ];
  // 非数字列表式选择：检测 ❯ Yes / No 模式（Claude Code 某些 prompt 的格式）
  // 至少有一行含 ❯（光标标记），否则不视为选择菜单
  const CHOICE_RE = /^(Yes|No|Allow|Deny|Cancel|Always|Never)\b/i;
  const menuLines = lines
    .map((l) => ({ raw: l, trimmed: l.replace(BOX_CHARS_RE, "").trim() }))
    .filter(
      ({ trimmed }) =>
        trimmed.includes("❯") || CHOICE_RE.test(trimmed.replace(/❯\s*/g, "")),
    );
  if (
    menuLines.length >= 2 &&
    menuLines.some(({ trimmed }) => trimmed.includes("❯"))
  ) {
    let ci = 0;
    const opts = menuLines.map(({ trimmed }, i) => {
      const hasCur = trimmed.includes("❯");
      const label = trimmed.replace(/❯\s*/g, "").trim().slice(0, 60);
      if (hasCur) ci = i;
      return { value: String(i + 1), label };
    });
    return opts.map((o, i) => ({ ...o, arrowsDown: i - ci }));
  }
  return [];
}

// ── HTTP 服务（接收 hook.js 的 POST，解析后转发给 broker） ───────────────────
// hook.js 仍然 POST 到 :3457，broker 会收到。此处不再单独开 HTTP。
// 但 hook.js 需要知道 SESSION_ID，通过环境变量 CC_NOTIFY_SESSION_ID 传入。
// hook.js 把 sessionId 附在 body 里，broker 按 sessionId 找到对应 claude-n。

// ── Runtime ───────────────────────────────────────────────────────────────────

const runtime = new ClaudeRuntime();

// ── 主流程 ────────────────────────────────────────────────────────────────────

let brokerSocket = null;

async function main() {
  // 0. hook 安装状态自检：未安装则警告但不阻塞（用户可能只想用 logs/status 等）
  if (!isHookInstalled()) {
    console.warn("⚠️  cc-notify hook 未安装，飞书通知不会触发");
    console.warn("   请先运行：claude-n install\n");
  }

  // 1. 确保 broker 在运行
  if (!(await isBrokerRunning())) {
    await startBroker();
  }

  // 2. 注册到 broker
  brokerSocket = await registerToBroker();
  logger.info(`[claude-n:${SESSION_ID}] 已注册到 broker`);

  // 3. 把 SESSION_ID 写入环境变量，让 claude 子进程的 hook.js 能读到
  process.env.CC_NOTIFY_SESSION_ID = SESSION_ID;

  // 4. 启动 Claude PTY
  runtime.on("exit", async (code) => {
    await unregister();
    process.exit(code ?? 0);
  });

  process.on("SIGINT", async () => {
    await unregister();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await unregister();
    process.exit(0);
  });

  runtime.start(process.argv.slice(2), process.cwd());
  logger.info(`[claude-n:${SESSION_ID}] Claude 已启动 | cwd: ${process.cwd()}`);
  logger.info(`[claude-n:${SESSION_ID}] 日志: ${LOG_FILE}`);
}

async function unregister() {
  if (!brokerSocket || brokerSocket.destroyed) return;
  send(brokerSocket, { type: "unregister", sessionId: SESSION_ID });
  // 给 broker 一点时间处理注销
  await new Promise((r) => setTimeout(r, 300));
  brokerSocket.destroy();
  brokerSocket = null;
}

// ── CLI 入口：子命令路由 ──────────────────────────────────────────────────────

const subcommand = process.argv[2];

if (subcommand === "install") {
  installHooks();
  process.exit(0);
} else if (subcommand === "uninstall") {
  uninstallHooks();
  process.exit(0);
} else if (subcommand === "--help" || subcommand === "-h") {
  console.log(`claude-n — Claude Code + 飞书远程控制

用法：
  claude-n              启动 Claude Code（带飞书通知）
  claude-n --debug      启动并把日志写入 cc-notify.log（默认不写）
  claude-n install      把 hook 写入 ~/.claude/settings.json
  claude-n uninstall    从 ~/.claude/settings.json 移除 hook
  claude-n --help       显示本帮助

首次使用：
  1. 配置 ~/.config/cc-notify/.env（FEISHU_APP_ID 等）
  2. claude-n install
  3. claude-n
`);
  process.exit(0);
} else {
  main().catch((err) => {
    console.error("[claude-n] 启动失败:", err.message);
    process.exit(1);
  });
}
