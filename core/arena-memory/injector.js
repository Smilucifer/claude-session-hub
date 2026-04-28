// core/arena-memory/injector.js
'use strict';
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SENTINEL_BEGIN = '<!-- ARENA_MEMORY_BEGIN -->';
const SENTINEL_END = '<!-- ARENA_MEMORY_END -->';

async function composeMemoryBlock({ projectCwd, budgetTokens = 1500 }) {
  const factsPath = path.join(store.getMemoryDir(projectCwd), 'shared', 'facts.md');
  if (!fs.existsSync(factsPath)) return '';
  const content = fs.readFileSync(factsPath, 'utf-8').trim();
  if (!content) return '';
  // 简单 token 预算：1 token ≈ 0.5 中文字 / 0.75 英文字。1500 tok ≈ 6000 chars 上限
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
  const beginIdx = prompt.indexOf(SENTINEL_BEGIN);
  const endIdx = prompt.indexOf(SENTINEL_END);
  if (beginIdx >= 0 && endIdx > beginIdx) {
    prompt = prompt.slice(0, beginIdx).replace(/\n+$/, '') + prompt.slice(endIdx + SENTINEL_END.length);
  }
  // 空 memoryBlock → 不写 sentinel
  if (memoryBlock && memoryBlock.trim()) {
    prompt = prompt.replace(/\n+$/, '') + '\n\n' + SENTINEL_BEGIN + '\n' + memoryBlock + '\n' + SENTINEL_END + '\n';
  }
  fs.writeFileSync(promptFilePath, prompt, 'utf-8');
}

module.exports = { composeMemoryBlock, appendMemoryToPromptFile, SENTINEL_BEGIN, SENTINEL_END };
