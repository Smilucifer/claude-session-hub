'use strict';
// General Roundtable mode — 通用圆桌讨论
// 与 research-mode（投研圆桌）平行的会议室模式：三家 AI 平等讨论任意话题
// 不预设场景，仅注入通用 rules + 可选用户公约（默认空）
//
// 与 research-mode 的关键区别：
//   - 不引导特定数据源（无 LinDangAgent / 投研专属）
//   - covenant 默认空字符串（用户想加再加，不预置场景模板）
//   - 触发语法多一个：@<who> 单家私聊（不入轮次）

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Template: General Roundtable rules（系统级，所有通用圆桌固定）
// ---------------------------------------------------------------------------
const GENERAL_ROUNDTABLE_RULES_TEMPLATE = `# 圆桌讨论规则

## 你的角色
你和另外两位 AI 同事（共三家：Claude / Gemini / Codex）受邀加入用户的圆桌讨论。
**地位完全平等，本色发挥，不需要扮演角色。** 你怎么思考就怎么回答，不要套模板。

## 圆桌的运作方式
用户用以下语法驱动讨论：

1. **默认提问**：用户发普通文本 → 三家独立回答（互不知情）。这一轮你不会看到另两家在写什么。
2. **@debate 触发**：用户发 \`@debate\` 或 \`@debate <补充信息>\` → 系统会把另两家上一轮的完整观点发给你 → 请你结合他们的视角发表新观点（可继承可反驳，可纳入用户补充的新信息）。
3. **@summary @<你> 触发**：用户发 \`@summary @claude\`（或 @gemini / @codex）→ 系统会把所有历史轮次的三家观点汇总给被点名那位 → 由他给出综合意见。
4. **@<你> 私聊**：用户发 \`@claude <内容>\`（或 @gemini / @codex / 多家但非全员）→ 仅你看到，不入圆桌历史。这是用户与你的私下讨论，专注一对一即可。

⚠ 你看不到另两家观点时，不要假装你看得到。专注本色独立回答。

## 协作礼仪
- @debate 时引用对方观点请明示（"Gemini 提到的 XX..."），便于用户追溯
- 不要因为另两家观点强势就放弃自己的判断；该坚持就坚持，该改就改要说明为什么
- @summary 阶段被点到时，写成可读决策报告（结论先行 + 关键分歧 + 行动建议），不要只复读三家观点
- 私聊时不要假装其他 AI 在场，专注一对一对话

## 工具与资源
你可以使用自己已有的能力辅助回答：联网搜索、读取本地文件、运行代码、调用 MCP 工具。
能查就查，不要假装"凭印象"。但每次工具调用前评估必要性，避免无意义的探查。

## 留白
你是用户的智囊伙伴，不是答题机器。
该坚持时坚持，该改主意时改主意，信息不足时主动说"我需要 X"。
`;

// 通用版默认 covenant 为空（不预设场景）。用户在 UI 编辑后写入 <id>-roundtable-covenant.md
const DEFAULT_COVENANT = '';

// 通用圆桌的 Claude resume 提醒
const GENERAL_ROUNDTABLE_RESUME_REMINDER = `[系统提醒] 你正在通用圆桌（Roundtable）中恢复会话。请继续遵守以下规则：
- 三家平等本色发挥，不扮演角色
- 用户驱动语法：默认提问（独立回答）/ @debate（看对方观点后再发）/ @summary @<你>（综合）/ @<你> 私聊（一对一）
- 善用你的工具（联网/读文件/跑代码/MCP）辅助回答
`;

// ---------------------------------------------------------------------------
// Prompt file management
// ---------------------------------------------------------------------------
function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 合成 system prompt 文件：rules（系统约束）+ covenant（用户偏好，可空）
// 三家共享同一文件，平等注入。
function writeGeneralRoundtablePromptFile(hubDataDir, meetingId, customCovenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-roundtable.md`);
  const covenant = (typeof customCovenantText === 'string' && customCovenantText.trim().length > 0)
    ? customCovenantText
    : DEFAULT_COVENANT;
  // covenant 非空时才追加分隔线 + 公约段；空 covenant 仅写 rules
  const content = covenant.trim().length > 0
    ? `${GENERAL_ROUNDTABLE_RULES_TEMPLATE}\n\n---\n\n${covenant}`
    : GENERAL_ROUNDTABLE_RULES_TEMPLATE;
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function writeCovenantSnapshot(hubDataDir, meetingId, covenantText) {
  const dir = arenaPromptsDir(hubDataDir);
  ensureDir(dir);
  const filePath = path.join(dir, `${meetingId}-roundtable-covenant.md`);
  fs.writeFileSync(filePath, covenantText || DEFAULT_COVENANT, 'utf-8');
  return filePath;
}

function readCovenantSnapshot(hubDataDir, meetingId) {
  const filePath = path.join(arenaPromptsDir(hubDataDir), `${meetingId}-roundtable-covenant.md`);
  if (!fs.existsSync(filePath)) return null;
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
}

function cleanupGeneralRoundtableFiles(hubDataDir, meetingId) {
  const dir = arenaPromptsDir(hubDataDir);
  if (!fs.existsSync(dir)) return;
  const targets = [
    `${meetingId}-roundtable.md`,
    `${meetingId}-roundtable-covenant.md`,
    `${meetingId}-roundtable-private.json`,
  ];
  for (const f of targets) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
}

module.exports = {
  GENERAL_ROUNDTABLE_RULES_TEMPLATE,
  DEFAULT_COVENANT,
  GENERAL_ROUNDTABLE_RESUME_REMINDER,
  writeGeneralRoundtablePromptFile,
  writeCovenantSnapshot,
  readCovenantSnapshot,
  cleanupGeneralRoundtableFiles,
};
