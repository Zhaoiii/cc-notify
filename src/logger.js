import fs from 'fs';
import os from 'os';
import path from 'path';

// 日志写到 ~/.config/cc-notify/cc-notify.log，避免散落在用户工作目录
const LOG_DIR = path.join(os.homedir(), '.config', 'cc-notify');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = path.join(LOG_DIR, 'cc-notify.log');
const stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

function fmt(level, args) {
  const ts = new Date().toISOString();
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
  return `${ts} [${level}] ${msg}\n`;
}

export const logger = {
  info:  (...args) => stream.write(fmt('INFO ', args)),
  error: (...args) => stream.write(fmt('ERROR', args)),
  debug: (...args) => stream.write(fmt('DEBUG', args)),

  /**
   * PTY 原始输出：先把光标右移序列转为空格，再剥离其余 ANSI，
   * 然后以原始文本形式追加到日志（不加时间戳前缀，保留原始排版）。
   */
  pty(data) {
    const clean = data
      .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(parseInt(n || '1', 10)))
      .replace(ANSI_RE, '')
      .replace(/\r/g, '');
    if (clean) stream.write(clean);
  },
};

export const LOG_FILE = LOG_PATH;
