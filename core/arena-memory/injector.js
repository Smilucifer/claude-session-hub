// core/arena-memory/injector.js
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SENTINEL_BEGIN = '<!-- ARENA_MEMORY_BEGIN -->';
const SENTINEL_END = '<!-- ARENA_MEMORY_END -->';

async function composeMemoryBlock({ projectCwd, budgetTokens = 800 }) {
  const factsPath = path.join(store.getMemoryDir(projectCwd), 'shared', 'facts.md');
  if (!fs.existsSync(factsPath)) return '';
  const content = fs.readFileSync(factsPath, 'utf-8').trim();
  if (!content) return '';
  // token 预算（混合中英内容偏保守估算）：
  // 1 中文字 ≈ 1-2 tokens，1 英文字 ≈ 0.25 tokens。
  // 默认 budget=800，char ceiling=3200，对纯中文约 4000-5000 tokens（控制副驾 prompt 注入量）
  const charBudget = budgetTokens * 4;
  const truncated = content.length > charBudget ? content.slice(0, charBudget) + '\n\n_[truncated due to budget]_' : content;
  return [
    '## 你已知的项目背景（来自 .arena/memory/shared/facts.md）',
    '',
    '> 这是本主驾会议室的共识快照，由 Hub 自动管理。',
    '',
    truncated,
  ].join('\n');
}

function appendMemoryToPromptFile(promptFilePath, memoryBlock) {
  if (!fs.existsSync(promptFilePath)) {
    throw new Error(`prompt file does not exist: ${promptFilePath}`);
  }
  let prompt = fs.readFileSync(promptFilePath, 'utf-8');
  // 幂等：先剥离旧的 sentinel 区块
  // lastIndexOf + END 在文件尾部双重判定：保证只剥 Hub 自己注入的（per design 在文件末尾），
  // 不会误吞用户内容里出现的字面 sentinel 字符串
  const beginIdx = prompt.lastIndexOf(SENTINEL_BEGIN);
  const endIdx = prompt.lastIndexOf(SENTINEL_END);
  const tailIsBlank = endIdx >= 0 && prompt.slice(endIdx + SENTINEL_END.length).trim() === '';
  if (beginIdx >= 0 && endIdx > beginIdx && tailIsBlank) {
    prompt = prompt.slice(0, beginIdx).replace(/\n+$/, '') + prompt.slice(endIdx + SENTINEL_END.length);
  }
  // 空 memoryBlock → 不写 sentinel
  if (memoryBlock && memoryBlock.trim()) {
    prompt = prompt.replace(/\n+$/, '') + '\n\n' + SENTINEL_BEGIN + '\n' + memoryBlock + '\n' + SENTINEL_END + '\n';
  }
  fs.writeFileSync(promptFilePath, prompt, 'utf-8');
}

module.exports = { composeMemoryBlock, appendMemoryToPromptFile, SENTINEL_BEGIN, SENTINEL_END };
