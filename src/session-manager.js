/**
 * SessionManager — 管理 Claude 进程的运行状态
 *
 * 当前实现为单 session（id = 'default'）。
 * Map 结构为未来 multi-agent 扩展预留：每个 Claude 进程对应一个 session。
 */
export class SessionManager {
  /** @type {Map<string, Session>} */
  #sessions = new Map();

  /**
   * 创建一个新 session。
   * @param {{ id?: string, cwd: string, notifyChatId: string }} opts
   */
  create({ id = 'default', cwd, notifyChatId }) {
    const session = {
      id,
      cwd,
      notifyChatId,
      /** 'idle' | 'running' | 'waiting' | 'stopped' */
      status: 'idle',
      /** Claude 当前是否在等待用户输入 */
      waitingForInput: false,
      /** 最近一次检测到 prompt 的时间戳 */
      lastPromptAt: null,
      /** 最近一次 prompt 的文本（用于 status 命令展示） */
      lastPromptText: null,
      /** 当前可选项列表（用于 router 验证用户输入） */
      currentOptions: [],
      /** 最近一次通知卡片的 message_id（用于后续更新卡片） */
      lastNotifyMessageId: null,
      /** 最近一次 approve/deny 的时间戳（防重复提交） */
      lastApprovedAt: null,
      /** 防重复提交的冷却时间（ms） */
      cooldownMs: 5_000,
    };
    this.#sessions.set(id, session);
    return session;
  }

  /** @param {string} [id='default'] */
  get(id = 'default') {
    return this.#sessions.get(id);
  }

  /** 获取第一个 session（单 session 场景快捷方法） */
  getDefault() {
    const first = this.#sessions.values().next();
    return first.done ? null : first.value;
  }

  /**
   * 标记 session 进入等待状态（prompt 已检测到）。
   * @param {string} id
   * @param {{ text: string, options: object[], messageId: string|null }} param
   */
  setWaiting(id, { text, options, messageId }) {
    const s = this.get(id);
    if (!s) return;
    s.status = 'waiting';
    s.waitingForInput = true;
    s.lastPromptAt = Date.now();
    s.lastPromptText = text;
    s.currentOptions = options;
    s.lastNotifyMessageId = messageId;
  }

  /** 标记 session 恢复运行（用户已响应） */
  setRunning(id) {
    const s = this.get(id);
    if (!s) return;
    s.status = 'running';
    s.waitingForInput = false;
    s.currentOptions = [];
  }

  /** 标记 session 已停止 */
  setStopped(id) {
    const s = this.get(id);
    if (s) s.status = 'stopped';
  }

  /**
   * 检查当前是否可以响应（防止重复提交）。
   * @param {string} id
   * @returns {{ ok: boolean, reason?: string }}
   */
  canRespond(id) {
    const s = this.get(id);
    if (!s) return { ok: false, reason: 'session 不存在' };
    if (!s.waitingForInput) return { ok: false, reason: '当前没有等待确认的操作' };
    if (s.lastApprovedAt && Date.now() - s.lastApprovedAt < s.cooldownMs) {
      return { ok: false, reason: '操作过于频繁，请稍后再试' };
    }
    return { ok: true };
  }

  /** 记录一次响应，重置等待状态 */
  markResponded(id) {
    const s = this.get(id);
    if (!s) return;
    s.lastApprovedAt = Date.now();
    s.waitingForInput = false;
    s.status = 'running';
    s.currentOptions = [];
  }
}
