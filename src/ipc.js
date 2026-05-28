/**
 * src/ipc.js — broker ↔ claude-n 的 IPC 协议
 *
 * 传输层：unix domain socket（/tmp/cc-notify-broker.sock）
 * 格式：换行分隔的 JSON（每条消息一行）
 *
 * claude-n → broker:
 *   { type:'register',   sessionId, cwd, pid }
 *   { type:'unregister', sessionId }
 *   { type:'hook_event', sessionId, event }   // Notification/Stop
 *
 * broker → claude-n:
 *   { type:'registered' }                     // 注册成功确认
 *   { type:'select',  choice }                // 用户选了某项
 *   { type:'stop' }                           // 用户要求停止进程
 */

import net from 'net';
import os from 'os';
import path from 'path';

export const BROKER_SOCK = path.join(os.tmpdir(), 'cc-notify-broker.sock');
export const BROKER_PORT = parseInt(process.env.CC_NOTIFY_PORT ?? '3457', 10);

/**
 * 向 socket 发送一条 JSON 消息（自动追加换行）。
 * @param {net.Socket} socket
 * @param {object} msg
 */
export function send(socket, msg) {
  socket.write(JSON.stringify(msg) + '\n');
}

/**
 * 给一个 socket 挂上换行分帧的 JSON 消息解析器。
 * @param {net.Socket} socket
 * @param {(msg: object) => void} onMessage
 */
export function onMessages(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop(); // 最后一段可能不完整
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        onMessage(JSON.parse(trimmed));
      } catch {
        // 忽略格式错误的帧
      }
    }
  });
}

/**
 * 连接到 broker unix socket，返回已连接的 Socket。
 * 连接失败则 reject。
 * @returns {Promise<net.Socket>}
 */
export function connectBroker() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(BROKER_SOCK);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/**
 * 检测 broker 是否正在运行（能否连上 unix socket）。
 * @returns {Promise<boolean>}
 */
export async function isBrokerRunning() {
  try {
    const s = await connectBroker();
    s.destroy();
    return true;
  } catch {
    return false;
  }
}
