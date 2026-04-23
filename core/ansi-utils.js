// core/ansi-utils.js

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor, scroll)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (title, hyperlinks)
    .replace(/\x1b\][^\x07\x1b]*/g, '')        // unterminated OSC (ConPTY truncation)
    .replace(/\x1b[()][AB012]/g, '')            // charset switches
    .replace(/\x1b[=>Nc7-9]/g, '')              // misc escape sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // control chars (keep \n \r \t)
}

// TUI noise patterns — ported from renderer-mobile + extended for Gemini/Codex
const TUI_LINE_PATTERNS = [
  // Claude CLI
  /bypass\s*permissions/i,
  /tab to cycle/i,
  /new task\?/i,
  /\/clear to save/i,
  /how is claude doing/i,
  /\d+:\s*(Bad|Fine|Good|Dismiss)/,
  /^\d*k?\s*tokens?\s*$/i,
  /^[─━═┈┉⎯⏵⏴\- \t]{4,}$/,        // separator lines (space/tab, not \s which matches too broadly)
  /ClaudeMax/i,
  /Smooshing/i,
  /Compacting/i,
  /^[❯]\s*(Research|Searching|Reading|Analyzing|Writing|Editing|Running)/i,
  // Gemini CLI
  /^Gemini\s+(Advanced|Ultra|Pro|Flash)/i,
  /^Model:\s+gemini/i,
  /^Tokens:\s+\d/i,
  /^[◆◇✔✗↓↑]\s+\w/,
  /Press Ctrl\+C/i,
  // Codex CLI
  /^apply patch\?/i,
  /^codex v\d/i,
];

function removePromptNoise(str) {
  return str
    .replace(/\r/g, '')
    // Strip (thinking) tags
    .replace(/\(thinking\)/g, '')
    // Strip ConPTY rendering artifacts: runs of special symbols
    .replace(/[★♯●·⏵⏴▶◀▸◂⬢⬡⎡⎤⎣⎦⎯]{2,}/g, '')
    // Strip braille spinners
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, '')
    // Strip progress bars
    .replace(/\[=*>?\s*\]\s*\d+%/g, '')
    // Strip only unambiguous shell prompt prefixes (not # or > which appear in Markdown/code)
    .replace(/^[❯$%]\s*/gm, '')
    // Strip lines matching TUI patterns or garbled ConPTY fragments
    .replace(/^.*$/gm, (line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      for (const pat of TUI_LINE_PATTERNS) {
        if (pat.test(trimmed)) return '';
      }
      // Short junk lines: no letters/digits/CJK (pure symbols/dots)
      if (trimmed.length < 10 && /^[^a-zA-Z\d㐀-鿿豈-﫿]*$/.test(trimmed)) return '';
      // Garble detection: ConPTY fragments have special symbols mixed with short letter runs
      if (trimmed.length >= 3) {
        const symbolCount = (trimmed.match(/[★♯●·⏵⏴▶◀▸◂⬢⬡]/g) || []).length;
        if (symbolCount >= 2) return '';
        const hasCJK = /[㐀-鿿豈-﫿]/.test(trimmed);
        const hasCodeChars = /[=(){}\[\];]/.test(trimmed);
        if (!hasCJK && !hasCodeChars) {
          // Split by whitespace (not by non-alpha) to avoid killing code like "const x = a.b;"
          const words = trimmed.split(/\s+/).filter(w => w.length > 0);
          const avgWordLen = words.length > 0 ? words.reduce((a, w) => a + w.length, 0) / words.length : 0;
          if (words.length > 5 && avgWordLen < 2.5) return '';
        }
      }
      return line;
    })
    // Collapse blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractLastResponse(cleaned) {
  const lines = cleaned.split('\n');
  let lastBoundary = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    // Only use actual shell prompts as boundary (not blank lines — AI output has legitimate paragraphs)
    if (/^(❯|[$%])\s/.test(lines[i])) {
      lastBoundary = i;
      break;
    }
  }
  if (lastBoundary >= 0 && lastBoundary < lines.length - 1) {
    return lines.slice(lastBoundary + 1).join('\n').trim();
  }
  return cleaned;
}

function smartTruncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  const truncated = str.slice(0, maxLen);
  const lastSentence = truncated.search(/[。.!！?？][^。.!！?？]*$/);
  if (lastSentence > maxLen * 0.5) {
    return truncated.slice(0, lastSentence + 1);
  }
  return truncated;
}

module.exports = { stripAnsi, removePromptNoise, extractLastResponse, smartTruncate };
