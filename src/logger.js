import fs from 'fs';
import os from 'os';
import path from 'path';

// 日志写到 ~/.config/cc-notify/cc-notify.log，避免散落在用户工作目录
const LOG_DIR = path.join(os.homedir(), '.config', 'cc-notify');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = path.join(LOG_DIR, 'cc-notify.log');

// 仅当 CC_NOTIFY_DEBUG=1 时才落盘日志，避免普通用户场景产生 IO
const DEBUG = process.env.CC_NOTIFY_DEBUG === '1';

// 行数上限：写满 MAX_LINES 后裁到 KEEP_LINES
const MAX_LINES = 2000;
const KEEP_LINES = 1500;
// 平均每行 ~120 字节，2000 行 ≈ 240KB；用字节阈值粗筛触发裁剪
const ROTATE_BYTES = 240 * 1024;

const stream = DEBUG ? fs.createWriteStream(LOG_PATH, { flags: 'a' }) : null;

let writesSinceCheck = 0;

function maybeRotate() {
  // 每写 100 次检查一次大小，超阈值才走精确行数裁剪
  if (++writesSinceCheck < 100) return;
  writesSinceCheck = 0;
  try {
    const { size } = fs.statSync(LOG_PATH);
    if (size < ROTATE_BYTES) return;
    const text = fs.readFileSync(LOG_PATH, 'utf8');
    const lines = text.split('\n');
    if (lines.length <= MAX_LINES) return;
    fs.writeFileSync(LOG_PATH, lines.slice(-KEEP_LINES).join('\n'));
  } catch { /* ignore */ }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

function fmt(level, args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  return `${ts} [${level}] ${msg}\n`;
}

function write(line) {
  if (!stream) return;
  stream.write(line);
  maybeRotate();
}

export const logger = {
  info:  (...args) => write(fmt('INFO ', args)),
  error: (...args) => write(fmt('ERROR', args)),
  debug: (...args) => write(fmt('DEBUG', args)),

  pty(data) {
    if (!stream) return;
    const clean = data
      .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
      .replace(ANSI_RE, '')
      .replace(/\r/g, '');
    if (clean) write(clean);
  },
};

export const LOG_FILE = LOG_PATH;
