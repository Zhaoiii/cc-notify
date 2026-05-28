#!/usr/bin/env node
/**
 * src/broker.js — cc-notify 常驻网关
 *
 * 职责：
 *   1. 唯一持有飞书 WS 长连接
 *   2. 监听 HTTP :3457，接收 hook.js 的 Notification/Stop 事件
 *   3. 监听 unix socket，接受 claude-n 实例注册/注销
 *   4. 收到飞书消息/卡片回调时，按 sessionId 路由到对应 claude-n 实例
 *   5. 注册表清空后自动退出
 *
 * 由 src/index.js 在第一个 claude-n 启动时自动 fork，不需要手动启动。
 */

import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { FeishuClient, buildPromptCard } from './feishu.js';
import { logger, LOG_FILE } from './logger.js';
import { BROKER_SOCK, BROKER_PORT, send, onMessages } from './ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── .env 加载 ─────────────────────────────────────────────────────────────────

import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';

const userEnv = path.join(homedir(), '.config', 'cc-notify', '.env');
const cwdEnv  = path.join(process.cwd(), '.env');
if (existsSync(userEnv))     loadDotenv({ path: userEnv });
else if (existsSync(cwdEnv)) loadDotenv({ path: cwdEnv });

// ── 环境变量 ──────────────────────────────────────────────────────────────────

const {
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_NOTIFY_CHAT_ID,
  FEISHU_ALLOWED_OPEN_IDS = '',
  FEISHU_ENCRYPT_KEY = '',
} = process.env;

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_NOTIFY_CHAT_ID) {
  logger.error('[broker] 缺少飞书凭证，退出');
  process.exit(1);
}

const allowedOpenIds = new Set(
  FEISHU_ALLOWED_OPEN_IDS.split(',').map(s => s.trim()).filter(Boolean)
);

// ── 注册表 ────────────────────────────────────────────────────────────────────

/**
 * sessions: Map<sessionId, { socket, cwd, pid, lastActiveAt }>
 * socket 是与该 claude-n 实例的 unix socket 连接
 */
const sessions = new Map();

function shortCwd(cwd) {
  // 取最后两段路径作为展示名，如 /Users/foo/mine/project → mine/project
  const parts = cwd.replace(/\/$/, '').split(path.sep);
  return parts.slice(-2).join('/');
}

function getMostRecent() {
  let best = null;
  for (const [id, s] of sessions) {
    if (!best || s.lastActiveAt > best.lastActiveAt) best = { id, ...s };
  }
  return best;
}

function checkEmpty() {
  if (sessions.size === 0) {
    logger.info('[broker] 注册表已空，5s 后自动退出');
    setTimeout(() => {
      shutdown();
    }, 5_000).unref();
  }
}

// ── 飞书客户端 ────────────────────────────────────────────────────────────────

const feishu = new FeishuClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  encryptKey: FEISHU_ENCRYPT_KEY,
});

// ── Hook 事件处理 ─────────────────────────────────────────────────────────────

async function handleHookEvent(sessionId, event) {
  const session = sessions.get(sessionId);
  if (!session) {
    logger.error(`[broker] hook 事件找不到 session: ${sessionId}`);
    return;
  }

  session.lastActiveAt = Date.now();

  if (event.hook_event_name === 'Notification') {
    // 通知卡片由 claude-n 实例已经解析好 options 和 promptText，通过 hook_event 转发过来
    const { options = [], promptText = '' } = event;

    const card = buildPromptCard({
      cwd: session.cwd,
      sessionId,
      promptText,
      options,
    });
    const messageId = await feishu.sendCard({ chatId: FEISHU_NOTIFY_CHAT_ID, card });
    if (messageId) session.lastNotifyMessageId = messageId;
  } else if (event.hook_event_name === 'Stop') {
    await feishu.sendText({
      chatId: FEISHU_NOTIFY_CHAT_ID,
      text: `🏁 [${sessionId}] ${shortCwd(session.cwd)} — Claude 会话已结束`,
    });
  }
}

// ── 飞书消息路由 ───────────────────────────────────────────────────────────────

function isAllowed(openId) {
  return allowedOpenIds.size === 0 || allowedOpenIds.has(openId);
}

/**
 * 解析消息文本，尝试从开头识别 sessionId 前缀。
 * 格式：`a3f2 1` 或 `a3f2 y` 或直接 `1`/`y`
 * 返回 { targetId: string|null, cmd: string }
 */
function parseTarget(text) {
  const parts = text.trim().split(/\s+/);
  if (parts.length >= 2 && sessions.has(parts[0])) {
    return { targetId: parts[0], cmd: parts.slice(1).join(' ') };
  }
  return { targetId: null, cmd: text.trim() };
}

feishu.start({
  onMessage: async ({ text, openId, messageId }) => {
    if (!isAllowed(openId)) return;

    const { targetId, cmd } = parseTarget(text);
    const session = targetId
      ? sessions.get(targetId)
      : getMostRecent();

    if (!session) {
      await feishu.replyText({ messageId, text: '⚠️ 当前没有活跃的 Claude 会话' });
      return;
    }

    const sessionId = targetId ?? [...sessions.entries()].find(([, v]) => v === session)?.[0];
    const lc = cmd.toLowerCase();

    if (/^\d+$/.test(lc)) {
      send(session.socket, { type: 'select', choice: lc });
      await feishu.replyText({ messageId, text: `✅ [${sessionId}] 已选择 ${lc}` });
    } else if (['y','yes','同意','允许','allow','approve','ok'].includes(lc)) {
      send(session.socket, { type: 'select', choice: 'y' });
      await feishu.replyText({ messageId, text: `✅ [${sessionId}] 已 approve` });
    } else if (['n','no','拒绝','deny','reject'].includes(lc)) {
      send(session.socket, { type: 'select', choice: 'n' });
      await feishu.replyText({ messageId, text: `❌ [${sessionId}] 已 deny` });
    } else if (lc === 'stop') {
      send(session.socket, { type: 'stop' });
      await feishu.replyText({ messageId, text: `🛑 [${sessionId}] 已发送 stop` });
    } else if (lc === 'status') {
      const lines = [];
      for (const [id, s] of sessions) {
        const age = Math.round((Date.now() - s.lastActiveAt) / 1000);
        lines.push(`• [${id}] ${shortCwd(s.cwd)}  (${age}s 前活跃, pid ${s.pid})`);
      }
      await feishu.replyText({
        messageId,
        text: sessions.size ? `**当前会话：**\n${lines.join('\n')}` : '⚠️ 当前无活跃会话',
      });
    }
  },
  onCardAction: async ({ openId, action, choice, sessionId: sid }) => {
    if (!isAllowed(openId)) return { toast: { type: 'error', content: '无操作权限' } };

    const session = sessions.get(sid);
    if (!session) return { toast: { type: 'info', content: '会话已结束' } };

    if (action === 'select' && choice) {
      send(session.socket, { type: 'select', choice });
    } else if (action === 'approve') {
      send(session.socket, { type: 'select', choice: 'y' });
    } else if (action === 'deny') {
      send(session.socket, { type: 'select', choice: 'n' });
    } else if (action === 'stop') {
      send(session.socket, { type: 'stop' });
    }
    return { toast: { type: 'success', content: '✅ 已操作' } };
  },
});

// ── HTTP 服务（接收 hook.js 的 POST） ─────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/hook') {
    res.writeHead(404); res.end(); return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    res.writeHead(200); res.end();
    let event;
    try { event = JSON.parse(body); } catch { return; }

    const sessionId = event.sessionId ?? getMostRecent()?.id;
    if (!sessionId) return;

    try {
      if (event.hook_event_name === 'Notification') {
        // Notification 需要 PTY 解析的 options/promptText，转发给 claude-n 处理
        const session = sessions.get(sessionId);
        if (!session) { logger.error(`[broker] hook 事件找不到 session: ${sessionId}`); return; }
        session.lastActiveAt = Date.now();
        send(session.socket, { type: 'hook_fwd', event });
      } else {
        // Stop 等事件直接处理
        await handleHookEvent(sessionId, event);
      }
    } catch (err) {
      logger.error('[broker] 处理 hook 事件失败:', err.message);
    }
  });
});

httpServer.listen(BROKER_PORT, '127.0.0.1', () => {
  logger.info(`[broker] HTTP 监听 127.0.0.1:${BROKER_PORT}/hook`);
});

// ── Unix Socket 服务（接受 claude-n 注册） ────────────────────────────────────

// 清理上次残留的 sock 文件
try { fs.unlinkSync(BROKER_SOCK); } catch { /* 不存在则忽略 */ }

const unixServer = net.createServer((socket) => {
  let registeredId = null;

  onMessages(socket, async (msg) => {
    if (msg.type === 'register') {
      const { sessionId, cwd, pid } = msg;
      registeredId = sessionId;
      sessions.set(sessionId, { socket, cwd, pid, lastActiveAt: Date.now() });
      send(socket, { type: 'registered' });
      logger.info(`[broker] 注册: [${sessionId}] ${shortCwd(cwd)} (pid ${pid}), 共 ${sessions.size} 个会话`);

      // 广播新会话到飞书
      await feishu.sendText({
        chatId: FEISHU_NOTIFY_CHAT_ID,
        text: `🟢 [${sessionId}] ${shortCwd(cwd)} 已接入 (共 ${sessions.size} 个会话)`,
      });

    } else if (msg.type === 'unregister') {
      const { sessionId } = msg;
      sessions.delete(sessionId);
      registeredId = null;
      logger.info(`[broker] 注销: [${sessionId}], 剩余 ${sessions.size} 个会话`);
      checkEmpty();
    } else if (msg.type === 'hook_result') {
      // claude-n 解析 PTY buffer 后回传的富化事件
      if (registeredId) {
        const s = sessions.get(registeredId);
        if (s) s.lastActiveAt = Date.now();
        await handleHookEvent(registeredId, msg.event).catch(err =>
          logger.error('[broker] hook_result 处理失败:', err.message)
        );
      }
    }
  });

  socket.on('close', () => {
    if (registeredId && sessions.has(registeredId)) {
      sessions.delete(registeredId);
      logger.info(`[broker] 连接断开，已移除 [${registeredId}]，剩余 ${sessions.size} 个`);
      checkEmpty();
    }
  });

  socket.on('error', () => { /* 连接错误时 close 会触发 */ });
});

unixServer.listen(BROKER_SOCK, () => {
  logger.info(`[broker] Unix socket 监听 ${BROKER_SOCK}`);
  logger.info(`[broker] 日志: ${LOG_FILE}`);
});

// ── 退出清理 ──────────────────────────────────────────────────────────────────

function shutdown() {
  logger.info('[broker] 正在关闭...');
  httpServer.close();
  unixServer.close();
  try { fs.unlinkSync(BROKER_SOCK); } catch { /* ignore */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
