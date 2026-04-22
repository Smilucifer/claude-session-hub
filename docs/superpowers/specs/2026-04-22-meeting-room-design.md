# Meeting Room (会议室) — 设计文档

> 日期：2026-04-22
> 状态：Draft → 待用户审阅

## 概述

在 Claude Session Hub 中新增"会议室"功能——一个轻量级多 AI 并排协作工作台。用户可在同一视图内并列运行最多 3 个 CLI session（Claude/Gemini/Codex），通过统一输入框广播或定向发送指令，并支持跨 session 的信息引用和自动上下文同步。

### 与 Team Room 的关系

**共存，定位不同。** Team Room 是"角色扮演协作"（YAML 预配置角色 + 人格 + MCP 回调），会议室是"原生 CLI 并排"（临时创建、无角色包装、直接看终端输出）。两者代码和 UI 完全独立。

## 数据模型

### 会议室对象

```javascript
{
  id: string,                    // UUID
  type: 'meeting',              // 区分普通 session
  title: string,                // "会议室-1"，可重命名
  subSessions: [sessionId, ...], // 子 session ID 数组，最多 3 个
  layout: 'split' | 'focus',    // 当前布局模式，默认 'split'
  focusedSub: sessionId | null, // focus 模式下聚焦的子 session
  syncContext: boolean,          // 自动上下文同步开关，默认 false
  sendTarget: 'all' | sessionId, // 当前发送目标
  createdAt: number,
  lastMessageTime: number,
  pinned: boolean,
  status: 'idle' | 'dormant'
}
```

### 子 session

复用普通 session 对象，增加归属字段：

```javascript
{
  ...normalSessionFields,
  meetingId: string | null      // 归属的会议室 ID，null 表示独立 session
}
```

### 持久化

- `state.json` 的 sessions 数组新增 meeting 类型条目
- 恢复时：先恢复会议室壳（dormant），子 session 各自作为 dormant 恢复，通过 `meetingId` 重建归属关系
- 用户点击会议室条目时唤醒所有子 session 的 PTY

### 关闭与退出行为

- **关闭会议室**：所有子 session 的 PTY 一并杀死，会议室和子 session 全部从 state 中删除
- **关闭单个子 session**（点 ×）：仅杀该子 session 的 PTY，从 subSessions 数组移除；会议室本身保留
- **子 session 自行退出**（CLI 进程结束）：该子 session 标记为 dormant，保留在 subSessions 中，显示为灰色可重新唤醒

## 模块职责

### 新增文件

| 文件 | 职责 |
|------|------|
| `core/meeting-room.js` | 会议室生命周期：创建/销毁会议室、添加/移除子 session、sendTarget 状态 |
| `renderer/meeting-room.js` | 会议室 UI：并列终端渲染、布局切换、输入框广播、引用交互、上下文同步注入 |
| `renderer/meeting-room.css` | 会议室样式 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `renderer/index.html` | 新增 `<div class="meeting-room-panel">` 面板；加号菜单增加"会议室"选项（分隔线隔开） |
| `renderer/renderer.js` | 侧栏渲染支持 meeting 类型条目（特殊图标 + 子 session 数量徽章）；`selectSession()` 识别 meeting 类型后委托给 meeting-room.js 的 `openMeeting()` |
| `main.js` | 新增 IPC handler：`create-meeting`、`add-meeting-sub`、`remove-meeting-sub`、`get-ring-buffer`、`update-meeting`；引入 `core/meeting-room.js` |
| `core/session-manager.js` | `createSession()` 支持接收 `meetingId` 选项，写入 session info |
| `core/state-store.js` | `save()/load()` 兼容 meeting 类型条目的序列化/反序列化 |

### 调用关系

```
renderer.js (侧栏 + 加号按钮)
  ├─ 点击"+会议室" → IPC create-meeting → core/meeting-room.js
  ├─ 点击会议室条目 → selectMeeting(id) → renderer/meeting-room.js.openMeeting(id)
  └─ renderSessionList() 渲染 meeting 条目（特殊图标）

renderer/meeting-room.js (主面板 UI)
  ├─ openMeeting(id) → 初始化并列终端面板
  ├─ addSubSession(kind) → IPC add-meeting-sub → core/meeting-room.js → session-manager.createSession()
  ├─ handleInput(text) → 根据 sendTarget 广播或单发 → IPC terminal-input
  ├─ quoteToSession(text, targetId) → 手动引用
  └─ syncContextInject(sessionId) → 自动上下文注入

core/meeting-room.js (后端逻辑)
  ├─ createMeeting() → 生成会议室对象
  ├─ addSubSession(meetingId, kind) → 调 sessionManager.createSession() + 更新 subSessions
  ├─ removeSubSession(meetingId, sessionId) → 移除 + 清理 PTY
  ├─ closeMeeting(meetingId) → 关闭会议室 + 杀所有子 session PTY
  └─ getMeeting(id) / getAllMeetings() → 查询
```

## UI 交互设计

### 侧栏

会议室条目与普通 session 混排，按最后活跃时间排序：

```
┌─────────────────────────┐
│ [+]  Claude Hub         │
├─────────────────────────┤
│ 🏢 会议室-1  [2]  14:30 │  ← 特殊图标 + 子session数量徽章
│ ● 修复登录bug    14:25  │  ← 普通 session
│ ● 重构API       13:50   │
│ 🏢 会议室-2  [3]  13:40 │
└─────────────────────────┘
```

加号菜单新增项（分隔线隔开）：

```
┌──────────────────┐
│ Claude Code      │
│ Claude (resume)  │
│ PowerShell       │
│ Team Room        │
│ ─────────────── │
│ 会议室           │
└──────────────────┘
```

### 主面板 — Split 模式（默认）

```
┌─────────────────────────────────────────────────────┐
│ 会议室-1          [Split|Focus]  [+添加]  [⚙设置]   │  header，无文件夹路径
├────────────────┬────────────────┬───────────────────┤
│ Claude      [×]│ Gemini      [×]│                   │
│                │                │    空 slot         │
│  xterm 终端 1  │  xterm 终端 2  │  "点击+添加子会话" │
│                │                │                   │
├────────────────┴────────────────┴───────────────────┤
│ 发送到: [▼ 全部]    [自动同步: 关]                    │  工具栏
│ ┌─────────────────────────────────────────┐ [发送]  │
│ │ 输入框                                   │        │
│ └─────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────┘
```

- 每个子 session 有独立 header：CLI 类型标签（只读）+ 关闭按钮
- 点击子 session header 选中该 session（高亮边框），sendTarget 自动切换
- 空 slot 显示引导文字（不足 3 个时）

### 主面板 — Focus 模式

```
┌─────────────────────────────────────────────────────┐
│ 会议室-1          [Split|Focus]  [+添加]  [⚙设置]   │
├─────────────────────────────────────────────────────┤
│ Claude                                           [×]│
│                                                     │
│              聚焦的 xterm 终端（全宽）                │
│                                                     │
├──────────┬──────────────────────────────────────────┤
│ [Gemini] │  ← 底部横向缩略预览条，点击切换聚焦目标    │
│ 最近输出  │    内容来自 ringBuffer                    │
└──────────┴──────────────────────────────────────────┤
│ 发送到: [▼ Claude]   [自动同步: 关]                  │
│ ┌─────────────────────────────────────────┐ [发送]  │
│ │ 输入框                                   │        │
│ └─────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────┘
```

- 缩略预览条：显示非聚焦 session 的最近几行输出（只读）
- 点击缩略预览切换聚焦目标

### 发送目标选择（双机制并存）

1. **工具栏下拉**：`[▼ 全部]` 下拉菜单列出"全部" + 各子 session 名称
2. **点击 header**：点击某个子 session header 选中（高亮边框），sendTarget 自动切为该 session；再次点击取消选中，回到"全部"

两种方式同步状态：下拉切换时 header 高亮跟随，点击 header 时下拉显示跟随。

### 信息交互

**手动引用**：
1. 在子 session 终端中选中文本
2. 右键菜单出现"引用到 [其他 session 名]..."
3. 点击后引用文本以引用块格式插入输入框
4. sendTarget 自动切换到目标 session

引用格式：
```
> [来自 Claude] 这个函数需要重构因为...
你觉得这个建议怎么样？
```

**自动上下文同步**（开关打开时）：

向某个 session 发消息前，自动拼接前缀：

```
[会议室上下文] 其他参会者最近的发言：
- Gemini: 建议使用策略模式重构...
- Codex: 发现了一个潜在的竞态条件...
---
<用户原始输入>
```

摘要来源：每个子 session 的 ringBuffer 最后 500 字符，截取最近一轮回复，truncate 到 200 字符。

## IPC 通道

| 通道 | 方向 | 类型 | 用途 |
|------|------|------|------|
| `create-meeting` | renderer → main | invoke | 创建会议室，返回 meeting 对象 |
| `add-meeting-sub` | renderer → main | invoke | 为会议室添加子 session（含 meetingId + kind），返回 session 对象 |
| `remove-meeting-sub` | renderer → main | invoke | 移除子 session，杀 PTY |
| `get-ring-buffer` | renderer → main | invoke | 获取指定 session 的 ringBuffer 内容 |
| `update-meeting` | renderer → main | send | 更新会议室属性（layout / syncContext / sendTarget / title 等） |
| `meeting-updated` | main → renderer | send | 会议室状态变更通知 |

子 session 的终端数据复用现有 `terminal-data` / `terminal-input` 通道，无需新建。

## 技术要点

### 终端并列渲染

- 每个子 session 独立拥有 xterm Terminal 实例和容器 div
- 复用 renderer.js 已有的 `getOrCreateTerminal(sessionId)` 创建/缓存 xterm 实例
- 挂载到会议室面板内的容器（非 terminal-panel）
- 布局切换只改 CSS class（flex 方向/比例），不销毁重建 xterm
- Focus 模式下非聚焦 session 的 xterm 容器 `display: none`，缩略预览条从 ringBuffer 渲染纯文本

### 输入广播

```javascript
function handleMeetingSend(text, meeting) {
  const targets = meeting.sendTarget === 'all'
    ? meeting.subSessions
    : [meeting.sendTarget];

  targets.forEach(sessionId => {
    let payload = text;
    if (meeting.syncContext) {
      const context = buildContextSummary(meeting, sessionId);
      payload = context + '\n' + text;
    }
    ipcRenderer.send('terminal-input', { sessionId, data: payload + '\r' });
  });
}
```

### 上下文摘要构建

```javascript
function buildContextSummary(meeting, excludeSessionId) {
  const others = meeting.subSessions.filter(id => id !== excludeSessionId);
  const lines = others.map(id => {
    const session = sessions.get(id);
    const recent = getRecentOutput(id, 500);
    const label = session.kind || 'session';
    return `- ${label}: ${truncate(recent, 200)}`;
  });
  return `[会议室上下文] 其他参会者最近的发言：\n${lines.join('\n')}\n---\n`;
}
```

### 手动引用

- 监听每个子 session xterm 容器的 `contextmenu` 事件
- 通过 `terminal.getSelection()` 获取选中文本
- 弹出自定义右键菜单，列出其他子 session 作为引用目标

## 约束与边界

- 子 session 最多 3 个
- 会议室之间相互独立，不能跨会议室引用
- 一个 session 只能属于一个会议室（`meetingId` 一对一）
- 自动上下文同步默认关闭，避免噪音
- 会议室不显示文件夹路径（header 区别于普通 session）
- 关闭会议室连带关闭所有子 session；子 session 自行退出则标记 dormant 可恢复
