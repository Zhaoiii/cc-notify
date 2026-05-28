import pty from "node-pty";
import { EventEmitter } from "events";
import { logger } from "./logger.js";

function escapeForLog(s) {
  return s
    .replace(/\x1b/g, "<ESC>")
    .replace(/\r/g, "<CR>")
    .replace(/\n/g, "<LF>");
}

/**
 * 管理 Claude CLI 的 PTY 进程生命周期。
 *
 * 通知触发已改为 Claude Code hooks（Notification / Stop 事件），
 * 本模块只负责：
 *   - 启动 / 停止 PTY 进程
 *   - 透传 stdin / stdout / resize
 *   - select()：把用户的选择写回 PTY（方向键 + 回车 or 字符）
 *   - 提供最近日志（供 `logs` 命令使用）
 *
 * 事件：
 *   'exit' — (exitCode: number)  进程退出
 */
export class ClaudeRuntime extends EventEmitter {
  /** @type {import('node-pty').IPty|null} */
  #proc = null;

  /** 纯文本输出缓冲（最多 10k 字符，供 logs 命令读取） */
  #buffer = "";

  /**
   * 当前 prompt 的可选项，由网关在收到 hook 事件后通过 setOptions() 写入，
   * select() 时消费。
   * @type {Array<{value:string, label:string, arrowsDown:number|null}>}
   */
  #currentOptions = [];

  get isRunning() {
    return this.#proc !== null;
  }

  get currentOptions() {
    return this.#currentOptions;
  }

  /**
   * 由网关在收到 Notification hook 事件后调用，写入解析好的选项列表。
   * @param {Array<{value:string, label:string, arrowsDown:number|null}>} options
   */
  setOptions(options) {
    this.#currentOptions = options;
  }

  /**
   * 启动 Claude 进程。
   * @param {string[]} args  传给 claude CLI 的参数
   * @param {string}   cwd   工作目录
   */
  start(args = [], cwd = process.cwd()) {
    if (this.#proc) throw new Error("ClaudeRuntime: 进程已在运行");

    this.#proc = pty.spawn("claude", args, {
      name: "xterm-256color",
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 30,
      cwd,
      env: process.env,
    });

    this.#proc.onData((data) => {
      process.stdout.write(data);
      this.#buffer += data;
      if (this.#buffer.length > 10_000) {
        this.#buffer = this.#buffer.slice(-10_000);
      }
    });

    this.#proc.onExit(({ exitCode }) => {
      this.#proc = null;
      this.emit("exit", exitCode);
    });

    process.stdin.setRawMode?.(true);
    process.stdin.on("data", (d) => this.#proc?.write(d));
    process.stdout.on("resize", () =>
      this.#proc?.resize(process.stdout.columns, process.stdout.rows),
    );
  }

  /** 向 PTY 进程写入原始字节 */
  write(raw) {
    if (!this.#proc) throw new Error("ClaudeRuntime: 进程未运行");
    this.#proc.write(raw);
  }

  /**
   * 选择一个选项，自动发送正确的按键序列。
   * @param {string} choiceValue  如 '1', '2', 'y', 'n'
   */
  async select(choiceValue) {
    const opt = this.#currentOptions.find((o) => o.value === choiceValue);

    // 计算按键序列：每个元素是一次"按键"，按键之间会插入延迟
    let keys;
    if (!opt) {
      keys = [...choiceValue, "\r"];
    } else if (opt.arrowsDown === null) {
      keys = [...opt.value, "\r"];
    } else {
      const DOWN = "\x1b[B";
      const UP = "\x1b[A";
      const n = opt.arrowsDown;
      const arrow = n >= 0 ? DOWN : UP;
      keys = Array.from({ length: Math.abs(n) }, () => arrow).concat("\r");
    }

    logger.info(
      `[runtime] select(${choiceValue}) opt=${JSON.stringify(opt)} currentOptions=${JSON.stringify(this.#currentOptions)} → ${keys.map(escapeForLog).join(" ")}`,
    );
    this.#currentOptions = [];

    // 按键之间留 40ms，让 TUI 有时间消费上一个按键并重绘
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 40));
      this.write(keys[i]);
    }
  }

  /** 强制终止 Claude 进程 */
  stop() {
    this.#proc?.kill();
    this.#proc = null;
  }

  /**
   * 获取最近 n 行终端输出（ANSI 转义序列已保留，飞书展示时用代码块包裹）。
   * @param {number} [lines=30]
   */
  getRecentLogs(lines = 30) {
    return this.#buffer.split("\n").slice(-lines).join("\n");
  }
}
