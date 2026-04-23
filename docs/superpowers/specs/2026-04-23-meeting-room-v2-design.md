# 会议室 v2 设计规格

日期: 2026-04-23

## 背景

会议室 v1 提供 Split/Focus/Blackboard 三种布局模式。实际使用中发现：
- **Split 模式太拥挤**：3 个终端并排时每个不到 40 列，CLI 状态栏截断，内容看不全
- **Blackboard 定位模糊**：同时承载摘要展示和同步操作，同步后自动跳走，变成"用完即走"的中间态
- **Focus 缺少状态感知**：看不到其他 AI 的工作状态和新输出提示
- **同步操作需切模式**：必须从 Focus 切到 Blackboard 才能触发同步

## 设计目标

1. 去掉 Split，Focus 成为唯一的终端工作模式
2. Focus tab 增加实时状态指示和未读提示
3. 同步操作移入 Focus toolbar，不需要切模式
4. Blackboard 重做为持久的会议纪要面板，Markdown 渲染

## 架构变化

### 模式精简: 3 → 2

| 模式 | 定位 | 核心动作 |
|------|------|---------|
| **Focus** | 主工作区——全宽终端 + tab 切换 | 广播消息、同步、定向追问 |
| **Blackboard** | 会议纪要——结构化展示 | 查看各 AI 摘要、Markdown 渲染 |

默认进入 Focus。Header 布局按钮从 `[Split] [Focus] [Blackboard]` 精简为 `[Focus] [Blackboard]`。

## 改动 1: 去掉 Split 模式

### 文件变更

- `renderer/meeting-room.js`:
  - `renderTerminals()`: 删除 split 分支（等宽 sub-slot 渲染 + 空 slot 逻辑）
  - `createSubSlot()`: 仅供 Focus 使用
  - `renderHeader()`: 移除 `mr-btn-split` 按钮
  - `setLayout()`: 移除 `'split'` case
- `renderer/meeting-room.css`: 清理 `.mr-empty-slot` 等 Split 专用样式
- `core/meeting-room.js`: `createMeeting()` 默认 `layout: 'focus'`（原为 `'split'`）
- `main.js` / `renderer.js`: boot restore 中 `layout === 'split'` 的旧数据自动迁移为 `'focus'`

### 数据迁移

`state.json` 中旧会议的 `layout: 'split'` 在启动时静默转为 `'focus'`。

## 改动 2: Focus Tab 状态指示

### 状态定义

| 状态 | 颜色 | 含义 | 触发条件 |
|------|------|------|---------|
| `streaming` | 绿色圆点 | AI 正在输出 | PTY 数据量 > 200 bytes 且仍在持续 |
| `new-output` | 黄色圆点 + `NEW` badge | 有未读新内容 | 非聚焦 tab 收到输出后 idle，用户未切过去看 |
| `idle` | 灰色圆点 | 空闲 | 无输出活动 |
| `error` | 红色圆点 | 出错/进程退出 | PTY 进程退出或 session closed |

### 实现

- 在 `meeting-room.js` 中维护 `_tabState` Map: `{ sessionId -> 'streaming' | 'new-output' | 'idle' | 'error' }`
- 监听 `terminal-data` IPC: 非聚焦 tab 收到数据时标记 `streaming`，数据停止后（silence timer）标记 `new-output`
- 切 tab 时将目标 tab 标记重置为 `idle`
- `renderHeader()` 中根据 `_tabState` 渲染对应颜色圆点和 NEW badge
- session-closed 事件标记 `error`

### CSS

```css
.mr-tab-status         { width: 7px; height: 7px; border-radius: 50%; }
.mr-tab-status.streaming  { background: #22c55e; }
.mr-tab-status.new-output { background: #eab308; }
.mr-tab-status.idle       { background: #6b7280; }
.mr-tab-status.error      { background: #ef4444; }
.mr-tab .new-badge     { font-size: 9px; padding: 1px 4px; background: rgba(250,204,21,0.25); color: #eab308; }
.mr-tab.has-new        { border-color: rgba(250,204,21,0.5); }
```

## 改动 3: 同步按钮移入 Focus Toolbar

### 当前状态

同步操作在 Blackboard 的 toolbar 中（快速同步/深度同步），同步完成后自动切回上一模式。

### 改动

- Focus 的 `renderToolbar()` 增加 `[同步]` 按钮
- 点击后调用 `handleSync(meeting, 'quick')`（复用 meeting-blackboard.js 的逻辑）
- 同步完成后不切换模式，保持 Focus
- Blackboard 的 toolbar 中移除同步按钮

### Toolbar 布局

```
[发送到: ▾全部] | [同步] | 自动同步: 关
```

## 改动 4: Blackboard 重做

### 当前状态

并排纯文本列（`escapeHtml` 直出），grid 布局和 Split 一样拥挤。

### 改动

- **布局**: 改为 Focus-tab 式切换，每个 AI 一个 tab，全宽展示
- **内容渲染**: 使用 `marked` 库将 SummaryEngine 的输出渲染为 HTML（代码块、列表、标题、表格）
- **信息头**: 每个 AI tab 页顶部显示 model badge + Ctx% + 最后更新时间
- **自动刷新**: 切到 Blackboard 时自动调用 `quick-summary` 刷新摘要
- **无操作按钮**: 纯展示面板

### Tab 栏

```
[Claude 1] [Gemini 1] [Codex 1]
```

与 Focus tab 共享样式但不需要状态指示。

### 文件变更

- `renderer/meeting-blackboard.js`: 重写 `renderBlackboard()`
  - 从并排 grid 改为 tab 切换 + 全宽 Markdown 渲染
  - 移除同步按钮
  - 添加 `marked` 渲染
- `renderer/meeting-room.css`: 更新 `.mr-blackboard` 样式

## 不做的事

- 不加操作按钮（采纳/导出等）
- 不加 diff 对比
- 不做语音输入
- 不做拖拽分隔线
- 不做会议室预设模板

## 依赖

- `marked` (npm): Markdown -> HTML。检查 `node_modules/marked` 是否存在
- `SummaryEngine` (已有): `core/summary-engine.js`

## 测试计划

每个改动完成后需 E2E 测试 + CDP 截图验证：

1. **去掉 Split**: 创建会议室 -> 验证默认 Focus -> 无 Split 按钮 -> 截图
2. **Tab 状态**: 创建多 AI 会议 -> 发消息 -> 验证状态变化 -> 截图
3. **同步按钮**: Focus toolbar 点同步 -> 验证不切模式 -> 截图
4. **Blackboard**: 切到 Blackboard -> 验证 tab 切换 + Markdown 渲染 -> 截图
5. **持久化**: 重启 Hub -> 验证 layout 恢复为 Focus -> 截图
