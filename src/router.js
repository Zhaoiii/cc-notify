import os from 'os';

// ── 命令集合 ──────────────────────────────────────────────────────────────────

const APPROVE_CMDS = new Set([
  'approve', 'allow', 'yes', 'y', '同意', '批准', '允许', 'ok',
]);
const DENY_CMDS = new Set([
  'deny', 'no', 'n', 'reject', '拒绝', '否', '不',
]);

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * 消息路由器：解析用户发来的文本/卡片动作，映射到对 ClaudeRuntime 的操作。
 *
 * 支持命令：
 *   approve / y / 同意     — 确认当前 prompt（发送 y 或选择第一项）
 *   deny / n / 拒绝        — 拒绝当前 prompt（发送 n）
 *   stop                   — 停止 Claude 进程
 *   status                 — 查看当前运行状态
 *   logs                   — 查看最近 30 行终端输出
 *   help / ?               — 命令说明
 */
export class Router {
  /** @type {import('./feishu.js').FeishuClient} */
  #feishu;

  /** @type {import('./claude-runtime.js').ClaudeRuntime} */
  #runtime;

  /** @type {import('./session-manager.js').SessionManager} */
  #sessions;

  /** 允许操作的用户 open_id 集合（空集 = 不限制） */
  #allowedOpenIds;

  /**
   * @param {{
   *   feishu: import('./feishu.js').FeishuClient,
   *   runtime: import('./claude-runtime.js').ClaudeRuntime,
   *   sessions: import('./session-manager.js').SessionManager,
   *   allowedOpenIds?: string[],
   * }} opts
   */
  constructor({ feishu, runtime, sessions, allowedOpenIds = [] }) {
    this.#feishu = feishu;
    this.#runtime = runtime;
    this.#sessions = sessions;
    this.#allowedOpenIds = new Set(allowedOpenIds);
  }

  /**
   * 处理飞书文本消息。
   * @param {{ text: string, chatId: string, openId: string, messageId: string }} msg
   */
  async handleMessage({ text, chatId, openId, messageId }) {
    if (!this.#isAllowed(openId)) return;

    const cmd = text.toLowerCase().trim();
    const session = this.#sessions.getDefault();

    if (APPROVE_CMDS.has(cmd)) {
      await this.#handleApprove(messageId, session);
    } else if (DENY_CMDS.has(cmd)) {
      await this.#handleDeny(messageId, session);
    } else if (cmd === 'stop') {
      await this.#handleStop(chatId, session);
    } else if (cmd === 'status') {
      await this.#handleStatus(chatId, session);
    } else if (cmd === 'logs') {
      await this.#handleLogs(chatId);
    } else if (cmd === 'help' || cmd === '?') {
      await this.#handleHelp(messageId);
    }
    // 其他消息静默忽略
  }

  /**
   * 处理卡片按钮点击回调。
   * 返回值传回给飞书 SDK，可包含 toast 或 card 更新。
   *
   * @param {{ openId: string, action: string, choice?: string, sessionId: string }} param
   * @returns {Promise<object>}
   */
  async handleCardAction({ openId, action, choice, sessionId }) {
    if (!this.#isAllowed(openId)) {
      return { toast: { type: 'error', content: '无操作权限' } };
    }

    const session = this.#sessions.get(sessionId ?? 'default');
    const check = this.#sessions.canRespond(session?.id ?? 'default');

    if (!check.ok) {
      return { toast: { type: 'info', content: check.reason } };
    }

    if (action === 'approve') {
      this.#doRespond(session, 'y');
    } else if (action === 'deny') {
      this.#doRespond(session, 'n');
    } else if (action === 'select' && choice) {
      this.#doRespond(session, choice);
    } else if (action === 'stop') {
      this.#runtime.stop();
      this.#sessions.setStopped(session?.id ?? 'default');
    }

    return { toast: { type: 'success', content: '✅ 已操作' } };
  }

  // ── 命令处理 ────────────────────────────────────────────────────────────────

  async #handleApprove(messageId, session) {
    const check = this.#sessions.canRespond(session?.id ?? 'default');
    if (!check.ok) {
      await this.#feishu.replyText({ messageId, text: `⚠️ ${check.reason}` });
      return;
    }
    // approve 时：若有选项则选第一个，否则发 y
    const firstOpt = session?.currentOptions?.[0];
    this.#doRespond(session, firstOpt ? firstOpt.value : 'y');
    await this.#feishu.replyText({ messageId, text: '✅ 已 approve' });
  }

  async #handleDeny(messageId, session) {
    const check = this.#sessions.canRespond(session?.id ?? 'default');
    if (!check.ok) {
      await this.#feishu.replyText({ messageId, text: `⚠️ ${check.reason}` });
      return;
    }
    this.#doRespond(session, 'n');
    await this.#feishu.replyText({ messageId, text: '❌ 已 deny' });
  }

  async #handleStop(chatId, session) {
    this.#runtime.stop();
    this.#sessions.setStopped(session?.id ?? 'default');
    await this.#feishu.sendText({ chatId, text: '🛑 Claude 进程已停止' });
  }

  async #handleStatus(chatId, session) {
    const s = session ?? { status: 'unknown', cwd: '?', waitingForInput: false, lastPromptAt: null };
    const promptAge = s.lastPromptAt
      ? `${Math.round((Date.now() - s.lastPromptAt) / 1_000)}s 前`
      : '无记录';

    const text = [
      `**🔄 状态：** ${s.status}`,
      `**📁 目录：** ${s.cwd}`,
      `**⏳ 等待确认：** ${s.waitingForInput ? '是 ⚠️' : '否'}`,
      `**🖥 主机：** ${os.hostname()}`,
      `**🕐 上次 prompt：** ${promptAge}`,
    ].join('\n');

    await this.#feishu.sendText({ chatId, text });
  }

  async #handleLogs(chatId) {
    const logs = this.#runtime.getRecentLogs(30);
    const trimmed = logs.slice(-3_000);
    await this.#feishu.sendText({ chatId, text: '```\n' + trimmed + '\n```' });
  }

  async #handleHelp(messageId) {
    const help = [
      '**可用命令：**',
      '`approve` / `y`    — 确认当前 prompt',
      '`deny` / `n`       — 拒绝当前 prompt',
      '`stop`             — 停止 Claude 进程',
      '`status`           — 查看当前运行状态',
      '`logs`             — 查看最近终端输出',
    ].join('\n');
    await this.#feishu.replyText({ messageId, text: help });
  }

  // ── 内部工具 ─────────────────────────────────────────────────────────────────

  /** 执行选择操作并更新 session 状态 */
  #doRespond(session, choiceValue) {
    this.#sessions.markResponded(session?.id ?? 'default');
    this.#runtime.select(choiceValue);
  }

  /** 检查用户是否有权操作（allowedOpenIds 为空时放行所有人） */
  #isAllowed(openId) {
    if (this.#allowedOpenIds.size === 0) return true;
    return this.#allowedOpenIds.has(openId);
  }
}
