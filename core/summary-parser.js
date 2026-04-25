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

function validateBusiness(data, presentAIs) {
  const isValidAI = (s) => typeof s === 'string' && presentAIs.has(s);
  const out = {
    consensus: data.consensus
      .filter(c => c && typeof c.text === 'string' && Array.isArray(c.supporters))
      .map(c => ({ ...c, supporters: c.supporters.filter(isValidAI) }))
      .filter(c => c.supporters.length > 0),
    disagreements: data.disagreements
      .filter(d => d && typeof d.topic === 'string' && Array.isArray(d.positions))
      .map(d => ({
        ...d,
        positions: d.positions
          .filter(p => p && typeof p.view === 'string' && isValidAI(p.by)),
      }))
      .filter(d => d.positions.length > 0),
    decisions: data.decisions
      .filter(dec => dec && typeof dec.text === 'string'),
    open_questions: data.open_questions
      .filter(q => typeof q === 'string' && q.length > 0),
  };
  return out;
}

function parse(rawOutput, presentAIs) {
  const obj = tryParseJson(rawOutput);
  if (!obj) {
    return { status: 'failed', raw_output: rawOutput, warnings: ['解析 JSON 失败'] };
  }
  const { result, warnings } = applySchema(obj);
  const validated = validateBusiness(result, presentAIs);
  return {
    status: warnings.length > 0 ? 'partial' : 'ok',
    data: validated,
    warnings,
  };
}

module.exports = { tryParseJson, applySchema, validateBusiness, parse };
