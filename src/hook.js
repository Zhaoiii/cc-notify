#!/usr/bin/env node
/**
 * src/hook.js — Claude Code hook 触发脚本
 *
 * Claude Code 每次触发 Notification / Stop 事件时，会把 JSON 写入
 * 此脚本的 stdin 并执行它。脚本把事件 POST 给本地网关（src/index.js 启动的
 * HTTP 服务），由网关负责发飞书通知。
 *
 * 设计要点：
 *   - 必须快速退出（Claude Code 会等待 hook 脚本返回）
 *   - 不阻塞：fire-and-forget，网关挂了也不影响 Claude 继续运行
 *   - exit 0：始终放行，不干涉 Claude 的正常流程
 *
 * 在 .claude/settings.json 中配置（见项目根目录）：
 *   {
 *     "hooks": {
 *       "Notification": [{ "hooks": [{ "type": "command", "command": "node /abs/path/src/hook.js" }] }],
 *       "Stop":         [{ "hooks": [{ "type": "command", "command": "node /abs/path/src/hook.js" }] }]
 *     }
 *   }
 */

import http from 'http';
import fs from 'fs';
import os from 'os';

const GATEWAY_PORT = parseInt(process.env.CC_NOTIFY_PORT || '3457', 10);

const _DEBUG = process.env.CC_NOTIFY_DEBUG === '1';
const _LOG = `${os.homedir()}/.config/cc-notify/cc-notify.log`;
function dbg(...args) {
  if (!_DEBUG) return;
  const ts = new Date().toISOString();
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  try { fs.appendFileSync(_LOG, `${ts} [INFO ] [TRACE][hook.js] ${msg}\n`); } catch { /* noop */ }
}

// 读取 stdin（Claude Code 写入的 hook 事件 JSON）
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  dbg(`stdin received, raw length=${raw.length}`);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    dbg('stdin JSON parse failed, raw:', raw.slice(0, 200));
    // 解析失败静默退出，不影响 Claude
    process.exit(0);
  }

  dbg(`event parsed: hook_event_name=${event.hook_event_name}`);

  // 附上 sessionId（由 claude-n 通过环境变量传入），broker 靠它路由到对应实例
  if (process.env.CC_NOTIFY_SESSION_ID) {
    event.sessionId = process.env.CC_NOTIFY_SESSION_ID;
    dbg(`sessionId attached: ${event.sessionId}`);
  } else {
    dbg('WARNING: CC_NOTIFY_SESSION_ID not set, broker will fallback to getMostRecent()');
  }

  // fire-and-forget POST 给网关，无论成功失败都立即 exit 0
  const body = JSON.stringify(event);
  dbg(`POST 127.0.0.1:${GATEWAY_PORT}/hook, body length=${body.length}`);

  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: '/hook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      dbg(`POST response: statusCode=${res.statusCode}`);
      process.exit(0);
    }
  );
  req.on('error', (err) => {
    dbg(`POST error: ${err.message}`);
    process.exit(0);
  });
  req.setTimeout(3000, () => {
    dbg('POST timeout (3s), aborting');
    req.destroy();
    process.exit(0);
  });
  req.write(body);
  req.end();
});
