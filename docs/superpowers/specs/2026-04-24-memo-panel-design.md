# Memo Panel (备忘区) Design Spec

## Problem

用户在与 Claude 对话过程中，经常产生新想法想提问，但 Claude 正在处理上一个问题无法立即输入。需要一个随时可用的备忘区来记录这些想法，稍后逐条回顾和使用。

## Decision Summary

| 决策项 | 选择 |
|--------|------|
| 作用域 | 全局（跨所有会话共享） |
| 位置 | 右侧面板，固定 280px |
| 内容组织 | 条目列表（每条带时间戳） |
| 使用方式 | 一键复制到剪贴板 |
| 持久化 | localStorage |
| 默认状态 | 收起 |
| 实现范围 | 纯渲染进程，不涉及主进程 |

## UI Layout

### Button Position

在 header 右侧按钮组中，`[A−]` 前面插入 memo toggle 按钮：

```
[memo] [A−] [A+] [X]
```

- 按钮尺寸：26x26px，与 `btn-zoom` 一致
- 图标：笔记本/便签 SVG
- 激活态：背景 `var(--accent)`，文字白色（复用 `.active` 样式）
- 两处 header 都加：常规会话 header + 会议室 header

### Panel Layout

```
┌──────────┬─────────────────────────┬──────────┐
│ Sidebar  │   Terminal Area         │ Memo     │
│          │   (自动缩窄)             │ Panel    │
│          │                         │ 280px    │
└──────────┴─────────────────────────┴──────────┘
```

- 面板在 `#terminal-panel` 右侧，作为 `.app-container` 的 flex 子元素
- 打开时 terminal area 自动缩窄（flexbox 自然行为）
- 关闭时 `display: none`，terminal area 恢复全宽
- 无展开/收起动画

### Panel Internal Structure

```
┌─────────────────────────┐
│  备忘录            [清空] │
├─────────────────────────┤
│ ┌─────────────────┬───┐ │
│ │ 输入想法...      │ + │ │
│ └─────────────────┴───┘ │
├─────────────────────────┤
│  14:30                  │
│  问一下缓存策略     📋 🗑 │
│                         │
│  14:31                  │
│  确认IPC超时处理    📋 🗑 │
│                         │
│  (空状态: 暂无备忘)      │
└─────────────────────────┘
```

## Data Model

**localStorage key:** `claude-hub-memo-items`

```json
[
  {"id": "m_1714000000", "text": "问一下关于缓存策略的想法", "ts": 1714000000000},
  {"id": "m_1714000060", "text": "确认 IPC 超时处理逻辑", "ts": 1714000060000}
]
```

**localStorage key:** `claude-hub-memo-open`

存储面板展开状态（`"true"` / `"false"`），重启后恢复。首次使用默认收起。

## Interaction Details

- **添加条目**：输入框输入文本，点击 `+` 按钮或按 Enter 添加。新条目插入列表顶部。
- **复制条目**：点击复制按钮，复制文本到剪贴板，按钮短暂显示 checkmark 反馈。
- **删除条目**：点击删除按钮，直接删除，无确认弹窗。
- **清空全部**：点击标题栏的清空按钮，清空所有条目。
- **输入框隔离**：输入框聚焦时 stopPropagation，不影响终端快捷键。
- **时间戳显示**：今天的条目只显示 `HH:MM`，跨天显示 `MM-DD HH:MM`。

## Styling

- 面板背景：`var(--bg-secondary)`
- 左边框：`1px solid var(--border)`
- 条目文本：`var(--text-primary)`
- 时间戳：`var(--text-secondary)`，小字号
- 按钮风格：复用现有 `btn-zoom` 的 hover/active 效果
- toggle 按钮激活态：`var(--accent)` 背景 + 白色文字

## Persistence

- 写入时机：每次添加/删除/清空后立即写 localStorage
- 读取时机：面板首次渲染时加载
- 展开状态持久化：仅在用户手动操作后才记录

## Files to Modify

| File | Changes |
|------|---------|
| `renderer/index.html` | 添加 `#memo-panel` 容器 div |
| `renderer/renderer.js` | 常规会话 header 添加 memo 按钮 + 面板渲染/交互逻辑 |
| `renderer/meeting-room.js` | 会议室 header 添加 memo 按钮 |
| `renderer/styles.css` | memo panel、按钮、条目列表样式 |

不修改：`main.js`、`core/` 目录下任何文件。

## Out of Scope

- 拖拽调整面板宽度
- 条目排序/搜索/分类
- 条目编辑（只能添加和删除）
- 导出/导入备忘
- 多窗口同步
