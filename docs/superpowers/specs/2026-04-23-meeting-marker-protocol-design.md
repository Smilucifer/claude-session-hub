# 会议室标记协议设计：从正则去噪到 AI 自标记

> 日期：2026-04-23
> 状态：Draft
> 前置：2026-04-23-meeting-summary-engine-design.md

## 1. 问题背景

当前 L0 摘要引擎用 40+ 正则从 ConPTY 终端输出中清洗噪声，效果差且维护成本高：
- TUI 渲染产物（spinner、box-drawing、braille）不断变化
- 各 CLI（Claude/Gemini/Codex）版本更新带来新的 UI chrome
- 正则误杀有价值内容（Markdown 标题、代码片段、数字）
- AI 输出包含大量中间过程（tool calls、Reading file...、Searching...），即使去掉 PTY 噪声，内容本身也不干净

## 2. 核心思路

借鉴 AI-Arena 的标记协议（`ARENA_START_R{N}` / `ARENA_DONE_R{N}`），将去噪责任从 Hub 转移给 AI 自身：

- 发送消息时，在用户 prompt 末尾追加标记指令
- AI 正常回答（用户在终端看到完整过程），在回答末尾用标记包裹自我摘要
- L0 只需 `lastIndexOf` 提取标记间内容，不再做任何正则清洗
- 标记的存在性还可用于推断 AI 的输出状态

## 3. 设计决策记录

| 决策项 | 选择 | 理由 |
|--------|------|------|
| 标记内容格式 | 单标记对 + 内部自由格式 | AI 遵从率最高，内部用 Markdown 自由组织 |
| AI 角色 | 既回答问题又做自我摘要 | AI 最了解自己的结论，是最佳摘要员 |
| Fallback 策略 | 无 fallback，返回空 + UI 提示 | 让用户有感知，避免静默降级给垃圾数据 |
| 标记注入位置 | 追加到用户消息末尾 | 简单直接 |
| 轮次编号 | 不需要，固定标记 | `lastIndexOf` 取最后一对即可解决跨轮问题 |
| 场景化指令 | 统一指令，不区分场景 | 保持标记指令简短，场景化交给 L2 |
| 注入范围 | 所有会议室消息都加 | 简单一致，AI 末尾的 TL;DR 对用户也有用 |

## 4. 标记协议

### 4.1 标记格式

```
<<<MEETING_SUMMARY>>>
（AI 自由组织的核心摘要）
<<<END_SUMMARY>>>
```

### 4.2 标记指令（追加到用户消息末尾）

```
（请在回答的最末尾，用 <<<MEETING_SUMMARY>>> 和 <<<END_SUMMARY>>> 标记包裹核心摘要（100-300字），保留关键结论与依据。若内容复杂难以精简，可将完整分析写入 .md 文件，标记内只需注明文件路径。不要解释这些标记。）
```

### 4.3 AI 输出示例

**常规模式：**
```
（正常的完整回答...工具调用...推理过程...代码编辑...）

<<<MEETING_SUMMARY>>>
核心结论：性能瓶颈在 DB 查询，存在 N+1 问题，影响 3 个 API 端点。
修复方案：改用批量查询 + 增加 eager loading，预计提升 3x。
未决问题：缓存策略待定，需要评估内存开销。
<<<END_SUMMARY>>>
```

**内容复杂模式：**
```
（大量分析过程...）

<<<MEETING_SUMMARY>>>
详细分析已写入 ./meeting-notes/performance-analysis.md
核心结论：3 处性能瓶颈，建议优先修复 DB N+1 问题，预计整体延迟降低 60%。
<<<END_SUMMARY>>>
```

## 5. L0 提取逻辑

### 5.1 提取流程

```
ring buffer 原始内容（16KB）
  ↓ stripAnsi()                — ANSI 转义清除（仍需保留）
  ↓ lastIndexOf(START_MARKER)  — 找最后一个开始标记
  ↓ lastIndexOf(END_MARKER)    — 找对应的结束标记
  ↓ 提取标记间内容             — 干净的 AI 自我摘要
  ↓ 返回
```

### 5.2 三种提取结果

| 情况 | 处理 | 返回值 |
|------|------|--------|
| 完整标记对 | 提取标记间内容 | 摘要文本 |
| 只有 START 无 END | AI 正在输出 | START 之后的部分内容 |
| 无任何标记 | 未检测到 | 空字符串 |

## 6. 基于标记的状态检测

标记的存在性可推断 AI 当前状态，展示在会议室 tab 上：

| 标记状态 | 推断 | Tab 指示器 |
|---------|------|-----------|
| 无任何标记 | 无响应/未开始 | `—`（默认） |
| 有 START 无 END | 正在输出 | `⏳`（输出中） |
| 有完整标记对 | 输出完成 | `✓`（完成） |

**展示位置：** Focus 模式 tab 按钮 + Split 模式 sub-slot header。

**检测时机：** 复用现有 `status-event` IPC 监听或 Blackboard 渲染时顺带检测，不需额外轮询。

## 7. 对现有模块的影响

### 7.1 保留

| 模块 | 函数/文件 | 理由 |
|------|----------|------|
| `ansi-utils.js` | `stripAnsi()` | ANSI 转义清理仍需要 |
| `summary-engine.js` | `deepSummary()` | L2 流程保留，输入变为标记提取的干净内容 |
| `summary-engine.js` | `buildInjection()` | 同步注入格式不变 |
| `config/summary-templates.json` | 全部 | L2 场景模板仍有用 |

### 7.2 删除

| 模块 | 函数/数组 | 理由 |
|------|----------|------|
| `ansi-utils.js` | `removePromptNoise()` | 40+ 正则不再需要 |
| `ansi-utils.js` | `extractLastResponse()` | shell prompt 边界检测不再需要 |
| `ansi-utils.js` | `smartTruncate()` | 标记内内容已精炼 |
| `ansi-utils.js` | `TUI_LINE_PATTERNS[]` | 全部删除 |

### 7.3 修改

| 模块 | 变更 |
|------|------|
| `summary-engine.js` → `quickSummary()` | 重写为 stripAnsi → 标记提取 |
| `meeting-room.js` → `handleMeetingSend()` | 发送时追加标记指令 |
| `meeting-room.js` → `renderHeader()` | tab 上增加状态指示器 |
| `meeting-blackboard.js` → `renderBlackboard()` | 基于标记提取 |

### 7.4 代码瘦身

`ansi-utils.js`：150 行 → ~20 行，只保留 `stripAnsi()` 一个导出函数。

## 8. 验证要求

### 8.1 代码审查

实现完成后，使用 enhanced-code-reviewer 或多路审查对所有改动文件进行代码审查，确保：
- 标记提取逻辑的边界情况覆盖完整
- 删除的旧代码无遗留引用
- 无安全问题（innerHTML XSS 等）

### 8.2 E2E 真实测试

必须在真实 Hub 实例中进行端到端测试，**并截图作证**：

1. **标记注入验证**：在会议室发送消息，截图证明消息末尾成功追加了标记指令
2. **标记提取验证**：AI 回答完成后，切换到 Blackboard 视图，截图证明成功提取到干净的摘要内容（非正则清洗的垃圾）
3. **状态指示器验证**：截图证明 tab 上的状态指示器（`—` / `⏳` / `✓`）正确反映 AI 输出状态
4. **无标记 fallback 验证**：截图证明未检测到标记时 UI 显示提示信息
5. **多 CLI 验证**：至少在 2 种 CLI（如 Gemini + Codex）上验证标记协议正常工作

测试使用隔离 Hub 实例（`CLAUDE_HUB_DATA_DIR` env 隔离），不得操作生产 Hub。

## 9. 与 AI-Arena 的差异

| 维度 | AI-Arena | 会议室 |
|------|---------|--------|
| 环境 | Web UI（DOM） | CLI 终端（PTY） |
| 标记用途 | 框全文回答 | 框末尾自我摘要 |
| 轮次编号 | `R{N}` 递增 | 固定标记，`lastIndexOf` |
| Fallback | 动态超时 + 手动按钮 | 返回空 + UI 提示 |
| 状态检测 | 轮询 hasStart/hasDone | 复用现有 IPC 事件 |
| 标记内容 | AI 自由格式 | AI 自由格式 + 可引用 .md 文件 |
