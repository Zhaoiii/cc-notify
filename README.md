# cc-notify

Claude Code 的 PTY wrapper，通过**飞书 WebSocket 长连接**实现远程监控与控制——无需公网 URL。

当 Claude Code 暂停等待你确认时，cc-notify 会向飞书群/私聊推送一张交互卡片，你可以直接点击按钮（或发文字指令）远程审批、拒绝或停止任务。

## 工作原理

```
claude-n（本地）
  │  PTY 包裹 Claude Code 进程
  │  检测到 hook 事件 → 解析 PTY buffer，提取选项
  └─► broker（后台常驻）
        │  唯一持有飞书 WebSocket 长连接
        │  收到卡片按钮回调 → 路由到对应 claude-n
        └─► 飞书（卡片通知 + 按钮回调）
```

- 第一个 `claude-n` 启动时自动 fork broker 进程。
- 后续 `claude-n` 实例直接向 broker 注册，多会话并行互不干扰。
- 所有实例退出后，broker 自动关闭。

## 前置条件

- Node.js >= 20
- 飞书自建应用（见下方[飞书配置](#飞书应用配置)）

## 安装

```bash
npm install -g cc-notify
```

## 飞书应用配置

在[飞书开放平台](https://open.feishu.cn/)完成以下步骤：

1. 创建自建应用 → 添加**机器人**能力
2. **权限管理** → 开通 `im:message`（发送消息）
3. **事件订阅** → 订阅方式选 **长连接（WebSocket）**
4. 添加事件：`im.message.receive_v1`（接收消息）和 `card.action.trigger`（卡片按钮回调）
5. 发布应用 → 把机器人添加到目标群聊或与目标用户建立私聊

## 配置

创建 `~/.config/cc-notify/.env`（全局配置，推荐），或在项目目录下放 `.env`：

```dotenv
# 飞书自建应用凭证（必填）
FEISHU_APP_ID=cli_xxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 通知目标：群 chat_id 或用户 open_id（必填）
# 群：oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# 用户：ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_NOTIFY_CHAT_ID=oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 允许发指令控制 Claude 的用户 open_id，逗号分隔（留空则不限制）
FEISHU_ALLOWED_OPEN_IDS=ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 消息加密 key（选填，与飞书后台安全配置对应）
FEISHU_ENCRYPT_KEY=
```

## 快速开始

```bash
# 1. 安装 Claude Code hook（写入 ~/.claude/settings.json，幂等）
claude-n install

# 2. 像平时用 claude 一样，把命令换成 claude-n 即可
claude-n
claude-n --resume
claude-n -p "帮我写单元测试"
```

首次接入时飞书会收到一条 `🟢 [xxxx] project/name 已接入` 的提示；会话结束时发送 `🏁` 通知。

## 远程控制

### 卡片按钮（推荐）

Claude Code 等待确认时，飞书会推送交互卡片，直接点击对应按钮即可：

- **主要按钮**（蓝色）：选择第一个选项 / Allow
- **默认按钮**（灰色）：选择对应选项
- **危险按钮**（红色）：Deny / 最后一个选项

### 文字指令

在飞书群内 @ 机器人（或私聊）发送指令：

| 指令 | 说明 |
|------|------|
| `1` / `2` / ... | 选择对应编号选项 |
| `y` / `yes` / `allow` / `approve` | 同意 |
| `n` / `no` / `deny` | 拒绝 |
| `stop` | 停止 Claude 任务 |
| `status` | 查看所有活跃会话 |

**多会话时**可在指令前加 session ID 前缀精准路由，例如 `a3f2 stop`。不加前缀则作用于最近活跃的会话。

## 其他命令

```bash
claude-n install      # 安装 hook 到 ~/.claude/settings.json
claude-n uninstall    # 移除 hook
claude-n --help       # 帮助
```

## 日志

broker 和各 claude-n 实例的日志写入同一个文件，路径在启动时打印（通常为 `~/.cache/cc-notify/cc-notify.log`）。

## 依赖

| 包 | 用途 |
|----|------|
| `@larksuiteoapi/node-sdk` | 飞书 HTTP API + WebSocket 客户端 |
| `node-pty` | 为 Claude Code 分配伪终端 |
| `strip-ansi` | 清理 ANSI 转义序列 |
| `dotenv` | 加载 `.env` 配置 |
