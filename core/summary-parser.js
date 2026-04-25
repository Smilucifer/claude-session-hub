// core/summary-parser.js

function tryParseJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch {}
  const codeBlock = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }
  return null;
}

function applySchema(obj) {
  const warnings = [];
  const safeArray = (val, name) => {
    if (Array.isArray(val)) return val;
    warnings.push(`${name} 字段缺失或类型错误`);
    return [];
  };
  const result = {
    consensus: safeArray(obj && obj.consensus, 'consensus'),
    disagreements: safeArray(obj && obj.disagreements, 'disagreements'),
    decisions: safeArray(obj && obj.decisions, 'decisions'),
    open_questions: safeArray(obj && obj.open_questions, 'open_questions'),
  };
  return { result, warnings };
}

module.exports = { tryParseJson, applySchema };
