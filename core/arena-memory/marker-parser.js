// core/arena-memory/marker-parser.js
'use strict';

const MARKER_RE = /^\s*\[(lesson|decision|fact)\]\s*[:：\-]?\s*(.+?)(?=\n\s*\[(?:lesson|decision|fact)\]|\n\n|\Z)/gms;
const TAG_RE = /#([a-zA-Z][\w-]{1,30})/g;

function parseMarkers(text, copilotKind) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const markers = [];
  // split by lines so we can compute line numbers
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*\[(lesson|decision|fact)\]\s*[:：\-]?\s*(.+)$/);
    if (!m) continue;
    let content = m[2].trim();
    const tags = [];
    let tagMatch;
    const tagRe = /#([a-zA-Z][\w-]{1,30})/g;
    while ((tagMatch = tagRe.exec(content)) !== null) tags.push(tagMatch[1]);
    content = content.replace(tagRe, '').trim();
    if (!content || content.length < 2) continue;
    markers.push({
      kind: m[1],
      who: copilotKind,
      content,
      tags,
      line: i,
    });
  }
  return markers;
}

module.exports = { parseMarkers };
