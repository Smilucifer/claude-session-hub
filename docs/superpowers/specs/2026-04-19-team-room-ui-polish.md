# AI Team Room UI 体验打磨 — 设计规格

## Context

2026-04-18 对 AI Team Room 进行了 9 场真实 CLI 场景测试（宁德时代抄底、兆易创新止盈、O-RAN 架构讨论、关税应急、多股对比、比特币配置等），发现 5 个 UI 问题影响用户理解对话结构和团队行为。本次只修这 5 个问题，不加新功能。

## 修改范围

- `renderer/team-room.js`（~855 行，改动约 80 行）
- `renderer/team-room.css`（~684 行，改动约 60 行）
- 不涉及 `main.js`、`core/`、`ai_team/` Python 后端

---

## Fix 1: tool_use 独立视觉样式

### 问题
tool_use 和 checkpoint 共用 `appendCheckpoint` + "路过说一下"样式，用户分不清"角色在汇报进度"和"角色在调工具"。

### 方案
新增 `appendToolUse` 函数 + `.tr-tool-use` CSS 类，与 checkpoint 视觉区分：

| 属性 | checkpoint | tool_use |
|------|-----------|----------|
| 头像 | 角色 emoji | 🔧 固定灰底 |
| 标签 | "路过说一下" | "调用工具" 绿底 |
| 边框 | 虚线 dashed | 实线 solid |
| 内容字体 | 正文 | monospace 代码风格 |
| 背景 | 透明 | `#1e2630` 深蓝灰 |
| 内容格式 | 原文 | `tool_name(param=value)` |

### 改动

**team-room.js**：
- 新增 `appendToolUse(parent, { actor, name, tool, input, ts })` 函数
- `handleStreamEvent` 中 `tool_use` 分支改为调 `appendToolUse`
- `refreshThread` 中 `tool_use` 分支同步改为 `appendToolUse`

**team-room.css**：
- 新增 `.tr-tool-use` 及子类（`.tr-tool-use-avatar`、`.tr-tool-use-body`、`.tr-tool-use-code`）

### 内容格式化
将 `{tool, input}` 格式化为可读的函数调用形式：
```
recall_facts(query="兆易创新", limit=5)
query_stock(code="603986.SH")
```
实现：遍历 input 对象 key-value，拼成 `key=JSON.stringify(value)` 形式，截断 120 字符。

---

## Fix 2: Round 分隔线

### 问题
对话从 Round 1 到 Round 4 是一坨流水，用户看不出哪些是独立思考（R1 并行）、哪些是互相补刀（R2+）。

### 方案
在 streaming 事件流中，根据角色发言顺序推断 Round 切换，插入分隔线。

### Round 推断逻辑
streaming 模式下没有显式 round_id，按以下规则推断：
- 维护 `streamRound = 1` 计数器
- 第一批 `thinking` 事件 = Round 1
- 收到 `message` 后，如果下一个 `thinking` 的 actor **已经在本轮发过言**，则 `streamRound++`
- 简化方案：**每次 thinking 事件时检查该 actor 是否已发言过**，已发言则插入新 Round 分隔

### 分隔线样式
```
── ROUND 1 · 独立思考 ──
── ROUND 2 · 互相补刀 ──
── ROUND 3+ · 深入讨论 ──
```
复用现有 `.tr-round-label` 样式，文字用居中虚线分隔。

### DB 历史加载
`refreshThread` 已有 `lastRound` + `evt.round_id` 逻辑，保持不变。

---

## Fix 3: evolution 结果可见

### 问题
`extraction_done` 和 `evolution_done` 事件在 `handleStreamEvent` 中没有处理，静默丢弃。用户不知道团队从对话中学到了什么。

### 方案
在收敛标签后追加一行绿色摘要条。

### 渲染逻辑
- 收到 `extraction_done` 时暂存 stats
- 收到 `evolution_done` 时合并两者 stats，渲染摘要行：

```
📝 提取 16 条记忆 · 学到 7 条经验 · 蒸馏 2 条共识
```

### DOM 结构
```html
<div class="tr-evolution-summary">
  📝 提取 <strong>16</strong> 条记忆 · 学到 <strong>7</strong> 条经验 · 蒸馏 <strong>2</strong> 条共识
</div>
```

### CSS
- 背景 `#1a2520`，边框 `1px solid #2a4a3a`，圆角 6px
- 字号 11px，颜色 `#7a7`，strong 颜色 `#8c8`
- 跟在 `.tr-round-label`（收敛）后面

---

## Fix 4: 长对话折叠

### 问题
thread 加载 200 个 DOM 元素后渲染变慢。

### 方案
**折叠旧消息**：thread 超过 50 个子元素时，将最早的元素折叠为一行可展开按钮。

### 实现
- `MAX_VISIBLE = 50`
- `_trimThread(threadEl)` 函数：在每次 append 后调用
  - 如果 `threadEl.children.length > MAX_VISIBLE`
  - 计算多余数量 `excess = length - MAX_VISIBLE`
  - 移除前 `excess` 个元素
  - 如果 thread 顶部没有折叠按钮，插入一行：
    ```html
    <div class="tr-collapsed-hint" onclick="TeamRoom.refreshThread()">
      ⋯ 点击加载更早的消息
    </div>
    ```
  - 如果已有折叠按钮，更新文字
- 点击折叠按钮时调 `refreshThread()` 重新加载全量历史

### 注意
- `_trimThread` 只在 streaming 模式下调用（`handleStreamEvent` 末尾）
- `refreshThread` 加载 DB 历史时不 trim（用户主动查看历史时应该看全量）
- 折叠按钮用 `.tr-collapsed-hint` 类，灰色居中文字+点击手势

---

## Fix 5: checkpoint 保持原样

checkpoint 的"路过说一下"虚线样式保持不变——Fix 1 已经通过给 tool_use 独立样式解决了混淆问题。

---

## 验证计划

### 单元验证（不需要 Hub）
- 修改后跑 Hub 现有 Node.js 测试（如有）

### E2E 验证（需要测试 Hub）
1. 创建 worktree，启动测试 Hub（`--remote-debugging-port=9555`）
2. 通过 CDP 注入以下事件序列，截图验证：
   - Round 1: 3 个 thinking → tool_use × 2 → message × 2 → 1 个仍在 thinking
   - Round 2: thinking(已发言角色) → message
   - 收敛 + extraction_done + evolution_done
3. 验证点：
   - [ ] tool_use 卡片用代码字体 + 实线 + 🔧 头像（非虚线"路过说一下"）
   - [ ] checkpoint 卡片保持虚线 + "路过说一下"
   - [ ] Round 分隔线在 R1 → R2 切换时自动出现
   - [ ] evolution 摘要条在收敛后可见
   - [ ] 连续注入 60 条 message 后，thread 自动折叠到 50 条 + 折叠按钮
4. 截图保存到 `~/.ai-team/test_screenshots/ui_polish_*.jpg`

### 真实 CLI E2E
1. 通过 `integration_test.py` 跑一个真实 `@team` 对话
2. 在测试 Hub 中查看完整对话流，确认所有 5 项修复在真实数据下正确渲染
