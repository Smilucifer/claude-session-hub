'use strict';
// 单测 parseDriverCommand 的 roundtableMode 分支
// renderer/meeting-room.js 是 IIFE + 引用 electron，Node 无法直接 require。
// 这里复制函数体到测试文件，与源代码同步维护。如果 parseDriverCommand 改了，请同步更新此文件。

const assert = require('assert');

// === 与 renderer/meeting-room.js::parseDriverCommand 严格同步 ===
function parseDriverCommand(text, meeting) {
  if (!meeting) return { type: 'normal', text, targets: null };
  if (meeting.researchMode) {
    let rest = text.trim();
    const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
    const debateRe = /^@debate\b\s*/i;
    let m;
    if ((m = rest.match(summaryRe))) return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
    if ((m = rest.match(debateRe))) return { type: 'rt-debate', text: rest.slice(m[0].length) };
    return { type: 'rt-fanout', text: rest };
  }
  if (meeting.roundtableMode) {
    let rest = text.trim();
    const summaryRe = /^@summary\s+@(claude|gemini|codex)\b\s*/i;
    let m;
    if ((m = rest.match(summaryRe))) return { type: 'rt-summary', summarizerKind: m[1].toLowerCase(), text: rest.slice(m[0].length) };
    const debateRe = /^@debate\b\s*/i;
    if ((m = rest.match(debateRe))) return { type: 'rt-debate', text: rest.slice(m[0].length) };
    const allRe = /^@all\b\s*/i;
    if ((m = rest.match(allRe))) return { type: 'rt-fanout', text: rest.slice(m[0].length) };
    const targets = [];
    const tokenRe = /^@(claude|gemini|codex)\b\s*/i;
    while (true) {
      const t = rest.match(tokenRe);
      if (!t) break;
      const tok = t[1].toLowerCase();
      if (!targets.includes(tok)) targets.push(tok);
      rest = rest.slice(t[0].length);
    }
    if (targets.length === 3) return { type: 'rt-fanout', text: rest };
    if (targets.length > 0) return { type: 'rt-private', targetKinds: targets, text: rest };
    return { type: 'rt-fanout', text: rest };
  }
  return { type: 'normal', text, targets: null };
}

// === Test cases ===
const RT = { roundtableMode: true };
const RM = { researchMode: true };
const NULL_M = null;
const NORMAL = {};

// roundtableMode 解析
console.log('Testing roundtableMode...');
assert.deepStrictEqual(parseDriverCommand('hello', RT), { type: 'rt-fanout', text: 'hello' });
console.log('  ✓ plain text → rt-fanout');

assert.deepStrictEqual(parseDriverCommand('@all hi', RT), { type: 'rt-fanout', text: 'hi' });
console.log('  ✓ @all → rt-fanout');

assert.deepStrictEqual(parseDriverCommand('@debate maybe', RT), { type: 'rt-debate', text: 'maybe' });
assert.deepStrictEqual(parseDriverCommand('@debate', RT), { type: 'rt-debate', text: '' });
console.log('  ✓ @debate (with/without text) → rt-debate');

assert.deepStrictEqual(parseDriverCommand('@summary @claude', RT), { type: 'rt-summary', summarizerKind: 'claude', text: '' });
assert.deepStrictEqual(parseDriverCommand('@summary @gemini why', RT), { type: 'rt-summary', summarizerKind: 'gemini', text: 'why' });
assert.deepStrictEqual(parseDriverCommand('@summary @codex', RT), { type: 'rt-summary', summarizerKind: 'codex', text: '' });
console.log('  ✓ @summary @<who> → rt-summary');

// @summary 无 @<who> 不会路由到 rt-summary，fall through 到 fanout
assert.deepStrictEqual(parseDriverCommand('@summary', RT), { type: 'rt-fanout', text: '@summary' });
assert.deepStrictEqual(parseDriverCommand('@summary please conclude', RT), { type: 'rt-fanout', text: '@summary please conclude' });
console.log('  ✓ @summary without @<who> falls through to rt-fanout (locked behavior)');

// 顺序锁定：@all 优先匹配并消耗 → 后续 @<who> 当字面量留在 text 里
assert.deepStrictEqual(parseDriverCommand('@all @claude foo', RT), { type: 'rt-fanout', text: '@claude foo' });
console.log('  ✓ @all @<who> → rt-fanout, @<who> stays as literal');

// @summary 优先匹配 @<who1>，剩余 @<who2> 作为 text 内容
assert.deepStrictEqual(parseDriverCommand('@summary @claude @gemini hi', RT), { type: 'rt-summary', summarizerKind: 'claude', text: '@gemini hi' });
console.log('  ✓ @summary @<a> @<b> → rt-summary(a), text contains @<b> literal');

assert.deepStrictEqual(parseDriverCommand('@claude solve', RT), { type: 'rt-private', targetKinds: ['claude'], text: 'solve' });
assert.deepStrictEqual(parseDriverCommand('@gemini hi', RT), { type: 'rt-private', targetKinds: ['gemini'], text: 'hi' });
assert.deepStrictEqual(parseDriverCommand('@codex check', RT), { type: 'rt-private', targetKinds: ['codex'], text: 'check' });
console.log('  ✓ @<who> single → rt-private');

assert.deepStrictEqual(parseDriverCommand('@claude @gemini comment', RT), { type: 'rt-private', targetKinds: ['claude', 'gemini'], text: 'comment' });
assert.deepStrictEqual(parseDriverCommand('@gemini @codex review', RT), { type: 'rt-private', targetKinds: ['gemini', 'codex'], text: 'review' });
console.log('  ✓ @<a> @<b> two-of-three → rt-private');

// 全 3 家应回退到 rt-fanout
assert.deepStrictEqual(parseDriverCommand('@claude @gemini @codex hi', RT), { type: 'rt-fanout', text: 'hi' });
console.log('  ✓ @claude @gemini @codex (all three) → rt-fanout (sugar)');

// 重复 @target 不重复
assert.deepStrictEqual(parseDriverCommand('@claude @claude solo', RT), { type: 'rt-private', targetKinds: ['claude'], text: 'solo' });
console.log('  ✓ @<who> @<who> dedup');

// researchMode 路径未变（C1 验证）
console.log('Testing researchMode (C1 zero regression)...');
assert.deepStrictEqual(parseDriverCommand('foo', RM), { type: 'rt-fanout', text: 'foo' });
assert.deepStrictEqual(parseDriverCommand('@debate', RM), { type: 'rt-debate', text: '' });
assert.deepStrictEqual(parseDriverCommand('@summary @codex', RM), { type: 'rt-summary', summarizerKind: 'codex', text: '' });
// researchMode 不解析 @<who> 单聊（保持原行为：直接进 fanout，文本是原文）
assert.deepStrictEqual(parseDriverCommand('@claude solo', RM), { type: 'rt-fanout', text: '@claude solo' });
console.log('  ✓ researchMode behavior unchanged');

// 边界
console.log('Testing edge cases...');
assert.deepStrictEqual(parseDriverCommand('hello', NULL_M), { type: 'normal', text: 'hello', targets: null });
assert.deepStrictEqual(parseDriverCommand('hello', NORMAL), { type: 'normal', text: 'hello', targets: null });
console.log('  ✓ null/empty meeting → normal');

console.log('\nAll parseDriverCommand tests passed.');
