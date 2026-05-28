import * as lark from '@larksuiteoapi/node-sdk';
import os from 'os';
import { logger } from './logger.js';

// ── Card builder ──────────────────────────────────────────────────────────────

/** 把终端输出包进可折叠面板（默认折叠，点开才看，避免群里刷屏） */
function collapsibleTerminalPanel(promptText) {
  const content = '```\n' + promptText.slice(-1_200) + '\n```';
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: '📄 终端输出（点击展开）' },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        color: 'grey',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content } },
    ],
  };
}

function buildHeader(cwd) {
  return [
    {
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'lark_md', content: `**📁 目录**\n${cwd}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**🖥 主机**\n${os.hostname()}` } },
      ],
    },
    { tag: 'hr' },
  ];
}

function buildFooter(timeStr) {
  return { tag: 'note', elements: [{ tag: 'plain_text', content: `🕐 ${timeStr}` }] };
}

/**
 * 构建 prompt 通知卡片（带操作按钮）。
 *
 * 按钮带 value 字段（而非 url），点击时飞书通过 WebSocket 回调 CardActionHandler，
 * 无需公网 URL，这是整个方案的核心优势。
 *
 * @param {{
 *   cwd: string,
 *   promptText: string,
 *   options: Array<{value:string, label:string, arrowsDown:number|null}>,
 *   sessionId: string,
 * }} param
 */
export function buildPromptCard({ cwd, promptText, options, sessionId }) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const elements = [
    ...buildHeader(cwd),
    collapsibleTerminalPanel(promptText),
  ];

  // 生成操作按钮（仅当解析到选项时才渲染）
  if (options.length > 0) {
    elements.push({ tag: 'hr' });
    const actions = options.slice(0, 4).map((opt, i) => {
      const isLast = i === options.length - 1 && i > 0;
      const action =
        opt.arrowsDown === null
          ? opt.value === 'y'
            ? 'approve'
            : 'deny'
          : 'select';
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: opt.label },
        type: i === 0 ? 'primary' : isLast ? 'danger' : 'default',
        value: { action, choice: opt.value, sessionId },
      };
    });
    elements.push({ tag: 'action', actions });
  }
  elements.push(buildFooter(time));

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '⚠️ Claude Code 等待你的确认' },
      template: 'orange',
    },
    elements,
  };
}

/**
 * 构建"已操作"的卡片（去掉按钮，显示已选择项）。
 * 用于 updateCard 替换原通知卡片。
 *
 * @param {{ cwd: string, promptText: string, chosenLabel: string }} param
 */
export function buildDonePromptCard({ cwd, promptText, chosenLabel }) {
  const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '✅ Claude Code 已处理' },
      template: 'green',
    },
    elements: [
      ...buildHeader(cwd),
      collapsibleTerminalPanel(promptText),
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**已选择：** ${chosenLabel}` } },
      buildFooter(time),
    ],
  };
}

// ── FeishuClient ──────────────────────────────────────────────────────────────

/**
 * 封装飞书 SDK：
 *   - HTTP API Client（发消息、更新卡片）
 *   - WSClient（长连接，接收消息事件 + 卡片按钮回调）
 *
 * 飞书应用配置步骤（需在开放平台完成）：
 *   1. 创建自建应用 → 添加"机器人"能力
 *   2. 权限管理 → 开通 im:message（发送消息）
 *   3. 事件订阅 → 订阅方式选"长连接（WebSocket）"
 *   4. 添加事件：im.message.receive_v1（接收消息）
 *   5. 发布应用 → 在目标群/私聊中添加机器人
 */
export class FeishuClient {
  /** @type {lark.Client} */
  #api;

  /** @type {lark.WSClient} */
  #ws;

  constructor({ appId, appSecret, encryptKey = '' }) {
    // 把飞书 SDK 的内部日志重定向到文件，不打到终端
    const sdkLogger = {
      error: (...args) => logger.error('[feishu-sdk]', ...args),
      warn:  (...args) => logger.info('[feishu-sdk]', ...args),
      info:  (...args) => logger.info('[feishu-sdk]', ...args),
      debug: (...args) => logger.debug('[feishu-sdk]', ...args),
      trace: (...args) => logger.debug('[feishu-sdk]', ...args),
    };

    this.#api = new lark.Client({ appId, appSecret, logger: sdkLogger });
    this.#ws = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel.debug,
      logger: sdkLogger,
    });
    this._encryptKey = encryptKey;
  }

  /**
   * 建立 WebSocket 长连接并注册事件处理器。
   *
   * @param {{
   *   onMessage: (msg: {text:string, chatId:string, chatType:string, openId:string, messageId:string}) => Promise<void>,
   *   onCardAction: (action: {openId:string, action:string, choice?:string, sessionId:string, chatId:string}) => Promise<object|void>
   * }} handlers
   */
  start({ onMessage, onCardAction }) {
    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: this._encryptKey,
    }).register({
      /**
       * 接收消息事件。
       * 仅处理文本消息，忽略图片、文件等其他类型。
       */
      'im.message.receive_v1': async (data) => {
        const msg = data.message;
        if (msg.message_type !== 'text') return;

        let text = '';
        try {
          text = JSON.parse(msg.content).text ?? '';
        } catch {
          return;
        }

        // 剥掉 @_user_N 占位符（群聊中 @ 机器人时飞书会插入这种 token）
        text = text.replace(/@_user_\d+/g, '').replace(/\s+/g, ' ').trim();

        await onMessage({
          text,
          chatId: msg.chat_id,
          chatType: msg.chat_type,
          openId: data.sender?.sender_id?.open_id ?? '',
          messageId: msg.message_id,
        });
      },

      /**
       * 卡片按钮点击回调。
       *
       * 在 WS 长连接模式下，卡片回调通过事件分发器以 'card.action.trigger'
       * 事件类型推送，而非独立的 CardActionHandler（后者只对 HTTP 回调模式生效）。
       *
       * 返回值会作为响应体回写给飞书；可包含 toast（操作提示）或 card（更新卡片内容）。
       * 飞书侧若超过约 5 秒未收到响应，会显示 "出错了,请稍后重试 code: 200340"。
       */
      'card.action.trigger': async (data) => {
        logger.debug('[feishu] card.action.trigger raw:', JSON.stringify(data));
        const result = await onCardAction({
          openId: data.operator?.open_id ?? '',
          action: data.action?.value?.action ?? '',
          choice: data.action?.value?.choice,
          sessionId: data.action?.value?.sessionId ?? 'default',
          chatId: data.open_chat_id ?? data.context?.open_chat_id ?? '',
        });
        logger.debug('[feishu] card.action.trigger result:', JSON.stringify(result));
        return result ?? {};
      },
    });

    this.#ws.start({ eventDispatcher });
    logger.info('[feishu] WebSocket 长连接已建立，等待事件...');
  }

  /**
   * 发送 Interactive Card 消息。
   * @param {{ chatId: string, card: object }} param
   * @returns {Promise<string|null>} 发送成功后的 message_id
   */
  async sendCard({ chatId, card }) {
    logger.info(`[TRACE][feishu] sendCard 调用: chatId=${chatId}`);
    try {
      const res = await this.#api.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      const messageId = res.data?.message_id ?? null;
      logger.info(`[TRACE][feishu] sendCard 成功: messageId=${messageId}`);
      return messageId;
    } catch (err) {
      logger.error('[TRACE][feishu] sendCard 失败:', err.message, 'code:', err.code);
      return null;
    }
  }

  /**
   * 发送纯文本消息。
   * @param {{ chatId: string, text: string }} param
   */
  async sendText({ chatId, text }) {
    try {
      await this.#api.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      logger.error('[feishu] sendText 失败:', err.message);
    }
  }

  /**
   * 回复某条消息（显示在消息气泡下方）。
   * @param {{ messageId: string, text: string }} param
   */
  async replyText({ messageId, text }) {
    try {
      await this.#api.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (err) {
      logger.error('[feishu] replyText 失败:', err.message);
    }
  }

  /**
   * 更新已发送的卡片内容（例如操作后改变按钮状态）。
   * @param {{ messageId: string, card: object }} param
   */
  async updateCard({ messageId, card }) {
    try {
      await this.#api.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err) {
      logger.error('[feishu] updateCard 失败:', err.message);
    }
  }
}
