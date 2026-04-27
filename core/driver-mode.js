'use strict';
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Template: Claude Driver system prompt
// ---------------------------------------------------------------------------
const DRIVER_RULES_TEMPLATE = `# Arena Rules — 主驾模式

## 你的角色
你是主驾（Driver）。你是唯一的执行者。
Gemini 和 Codex 是副驾（Copilot），只提供建议和审查，不修改文件。

## 职责
1. 理解用户需求，制定方案，执行文件修改和命令
2. 在项目根目录维护 .arena/state.md，每次重要决策后更新：
   - Goal: 当前目标
   - Plan: 当前计划
   - Scope: 涉及的文件/命令/模块
   - Open Risks: 未消解的风险
3. 需要第二视角时，输出 [REQUEST_REVIEW] 请求副驾审查
4. 收到副驾 FLAG 提醒时，在回复中说明是否采纳及理由
5. 收到 BLOCKER 时，暂停执行，等待用户确认

## 何时请求审查
以下场景输出 [REQUEST_REVIEW]，并在标记后附带简短说明：
- 跨 3 个以上文件的修改
- 引入新依赖、新模块、新抽象
- 架构变更或跨文件重构
- 存在未消解的 Open Risks
- 你对方案不确定

格式示例：
[REQUEST_REVIEW] 正在重构认证模块，涉及 3 个文件，不确定 OAuth 回调的
错误处理是否完整。请重点看 handleCallback() 函数。

## 危险操作
以下操作前必须输出 [DANGER_REVIEW] 并附带说明：
- rm / delete / overwrite 文件或目录
- git reset --hard / git push --force
- 修改 .env / token / key / secret
- 数据库 migrate / drop / reset
- 修改 hook / CI / 自动化执行链路
- chmod / chown / 大范围目录迁移

## 为副驾提供上下文摘要
当系统要求你提供上下文摘要时（收到 [SUMMARIZE_FOR_COPILOT] 指令），
请用以下结构回复，控制在 500 字以内：

**当前目标**：一句话说明用户要做什么
**已完成**：已经做了哪些关键操作（列出文件名和核心变更）
**进行中**：当前正在执行什么
**关注点**：你认为副驾应该重点检查什么
**涉及文件**：本轮涉及的文件路径列表

要求：
- 贴出涉及的关键代码变更（函数签名、核心逻辑片段），不要只用文字描述
- 如果涉及危险操作，明确说明即将执行的命令
- 简洁，不要长篇大论

## .arena/ 初始化
如果 .arena/ 目录不存在，请在首次对话时创建：
  .arena/rules.md — 复制本规则
  .arena/state.md — 四段空模板（Goal/Plan/Scope/Open Risks）
创建后回复：主驾模式已初始化。
`;

// ---------------------------------------------------------------------------
// Template: Gemini copilot system prompt
// ---------------------------------------------------------------------------
const COPILOT_PROMPT_GEMINI = `# 你是审查副驾 — Gemini

## 角色
你是会议室中的架构审查副驾。
你的唯一职责是在收到审查请求时，从以下角度审查：
- 方案合理性：目标是否清晰，路径是否最优
- 架构风险：是否引入不必要的复杂度
- 需求理解：是否偏离用户原意

## 权限
- 你可以读取项目中的任何文件来辅助审查（grep、cat、read）
- 你可以读取 .arena/context.md 获取完整对话历史
- 你不得修改任何文件
- 你不得执行写命令（rm、mv、git push 等）
- 你不接管执行权，只提供建议

## 审查流程
1. 阅读审查请求中提供的上下文
2. 如果信息不足，主动读取相关源码文件或 .arena/context.md
3. 给出判定

## 输出格式
收到审查请求时，第一行必须是判定：
  OK: 无问题，方案合理
  FLAG: [一句话隐患提醒]
  BLOCKER: [一句话严重问题]
之后可附 1-3 句简短理由。不要长篇大论。
`;

// ---------------------------------------------------------------------------
// Template: Codex copilot system prompt
// ---------------------------------------------------------------------------
const COPILOT_PROMPT_CODEX = `# 你是审查副驾 — Codex

## 角色
你是会议室中的代码实现审查副驾。
你的唯一职责是在收到审查请求时，从以下角度审查：
- 代码正确性：逻辑错误、类型错误、引用遗漏
- 边界条件：null/undefined、空数组、超时、并发
- 测试遗漏：关键路径是否有测试覆盖

## 权限
- 你可以读取项目中的任何文件来辅助审查（grep、cat、read）
- 你可以读取 .arena/context.md 获取完整对话历史
- 你不得修改任何文件
- 你不得执行写命令（rm、mv、git push 等）
- 你不接管执行权，只提供建议

## 审查流程
1. 阅读审查请求中提供的上下文
2. 如果信息不足，主动读取相关源码文件或 .arena/context.md
3. 给出判定

## 输出格式
收到审查请求时，第一行必须是判定：
  OK: 代码实现无明显问题
  FLAG: [一句话实现隐患]
  BLOCKER: [一句话严重 bug]
之后可附 1-3 句简短理由。不要长篇大论。
`;

// ---------------------------------------------------------------------------
// Template: Resume reminder (injected when resuming a driver-mode session)
// ---------------------------------------------------------------------------
const DRIVER_RESUME_REMINDER = `[系统提醒] 你正在主驾模式中恢复会话。请继续遵守以下规则：
- 你是主驾，Gemini/Codex 是副驾，只有你能修改文件和执行命令
- 执行危险操作前输出 [DANGER_REVIEW]，需要第二视角时输出 [REQUEST_REVIEW]
- 维护 .arena/state.md，每次重要决策后更新
`;

const SUMMARIZE_INSTRUCTION = '[SUMMARIZE_FOR_COPILOT] 请用 500 字以内总结当前任务状态，用于副驾审查。格式：当前目标/已完成/进行中/关注点/涉及文件，并贴出关键代码变更。';

// ---------------------------------------------------------------------------
// Prompt file management
// ---------------------------------------------------------------------------
function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeDriverPromptFile(hubDataDir, meetingId) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-driver.md`);
  fs.writeFileSync(filePath, DRIVER_RULES_TEMPLATE, 'utf-8');
  return filePath;
}

function writeCopilotPromptFile(hubDataDir, meetingId, kind) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const content = kind === 'gemini' ? COPILOT_PROMPT_GEMINI : COPILOT_PROMPT_CODEX;
  const filePath = path.join(dir, `${meetingId}-${kind}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function cleanupPromptFiles(hubDataDir, meetingId) {
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) return;
  for (const suffix of ['driver.md', 'gemini.md', 'codex.md']) {
    const f = path.join(dir, `${meetingId}-${suffix}`);
    try { fs.unlinkSync(f); } catch {}
  }
}

// ---------------------------------------------------------------------------
// .arena/context.md — timeline snapshot written before each review
// ---------------------------------------------------------------------------
const MAX_CONTEXT_CHARS = 50000;
const MAX_TURN_CHARS = 1500;

function writeContextSnapshot(arenaDir, timeline, labelMap) {
  ensureDir(arenaDir);
  const filePath = path.join(arenaDir, 'context.md');
  const lines = [
    '# 会议室 Timeline 快照',
    `# 自动生成，勿手动编辑。副驾审查时可读取此文件获取完整对话历史。`,
    `# 更新时间：${new Date().toLocaleString('zh-CN')}`,
    '',
  ];
  let total = lines.join('\n').length;
  for (const turn of timeline) {
    let label = '未知';
    if (turn.sid === 'user') {
      label = '用户';
    } else if (labelMap && labelMap.has(turn.sid)) {
      const meta = labelMap.get(turn.sid);
      label = meta.label || meta.kind || 'AI';
    }
    let text = typeof turn.text === 'string' ? turn.text : '';
    if (text.length > MAX_TURN_CHARS) {
      text = text.slice(0, MAX_TURN_CHARS) + '…[已截断]';
    }
    const line = `[#${turn.idx}] [${label}]: ${text}`;
    if (total + line.length + 1 > MAX_CONTEXT_CHARS) {
      lines.push(`[…后续 ${timeline.length - (turn.idx || 0)} 条已省略]`);
      break;
    }
    lines.push(line);
    total += line.length + 1;
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// Build review payload sent to copilot PTY
// ---------------------------------------------------------------------------
const MAX_REVIEW_PAYLOAD = 20000;

function buildReviewPayload({ kind, triggerType, triggerText, claudeSummary, claudeLastOutput, recentTimeline, userText }) {
  const roleLabel = kind === 'gemini'
    ? '你是架构审查副驾（Gemini）。请从方案/架构/需求理解角度审查。'
    : '你是代码实现审查副驾（Codex）。请从代码正确性/边界条件/测试遗漏角度审查。';

  const sections = [];
  sections.push('=== 审查请求 ===');
  sections.push(`角色: ${roleLabel}`);
  sections.push(`触发方式: ${triggerType}`);
  sections.push('');

  if (claudeSummary) {
    sections.push('--- Claude 任务摘要 ---');
    sections.push(claudeSummary.slice(0, 5000));
    sections.push('');
  }

  if (recentTimeline) {
    sections.push('--- 近期对话 ---');
    sections.push(recentTimeline.slice(0, 8000));
    sections.push('');
  }

  if (claudeLastOutput) {
    sections.push('--- Claude 最近操作（完整输出） ---');
    sections.push(claudeLastOutput.slice(0, 10000));
    sections.push('');
  }

  if (userText) {
    sections.push('--- 用户补充 ---');
    sections.push(userText);
    sections.push('');
  }

  sections.push('如需更多上下文，可读取 .arena/context.md 或项目源码文件。');
  sections.push('');
  sections.push('请用以下格式回复（第一行必须是判定）:');
  sections.push('OK|FLAG|BLOCKER: 一句话理由');

  let payload = sections.join('\n');
  if (payload.length > MAX_REVIEW_PAYLOAD) {
    payload = payload.slice(0, MAX_REVIEW_PAYLOAD) + '\n[…已截断]';
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Parse copilot review verdict
// ---------------------------------------------------------------------------
function parseReviewVerdict(text) {
  if (!text || typeof text !== 'string') {
    return { verdict: 'FLAG', reason: '副驾无响应' };
  }
  const firstLine = text.trim().split('\n')[0];
  const match = firstLine.match(/^(OK|FLAG|BLOCKER)\s*[:：]\s*(.+)/i);
  if (match) {
    return { verdict: match[1].toUpperCase(), reason: match[2].trim() };
  }
  return { verdict: 'FLAG', reason: '副驾输出格式异常: ' + firstLine.slice(0, 150) };
}

// ---------------------------------------------------------------------------
// Format recent timeline turns for review prompt
// ---------------------------------------------------------------------------
function formatRecentTimeline(timeline, labelMap, count) {
  const n = count || 10;
  const recent = timeline.slice(-n);
  if (recent.length === 0) return '';
  const lines = ['[会议室近期对话]'];
  for (const t of recent) {
    let label = '未知';
    if (t.sid === 'user') {
      label = '你';
    } else if (labelMap && labelMap.has(t.sid)) {
      const meta = labelMap.get(t.sid);
      label = meta.label || meta.kind || 'AI';
    }
    let text = typeof t.text === 'string' ? t.text : '';
    if (text.length > 800) text = text.slice(0, 800) + '…';
    lines.push(`【${label}】${text}`);
  }
  lines.push('---');
  return lines.join('\n');
}

module.exports = {
  DRIVER_RULES_TEMPLATE,
  COPILOT_PROMPT_GEMINI,
  COPILOT_PROMPT_CODEX,
  DRIVER_RESUME_REMINDER,
  SUMMARIZE_INSTRUCTION,
  writeDriverPromptFile,
  writeCopilotPromptFile,
  cleanupPromptFiles,
  writeContextSnapshot,
  buildReviewPayload,
  parseReviewVerdict,
  formatRecentTimeline,
};
