// core/ansi-utils.js

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI sequences (colors, cursor, scroll)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (title, hyperlinks)
    .replace(/\x1b[()][AB012]/g, '')            // charset switches
    .replace(/\x1b[=>Nc7-9]/g, '')              // misc escape sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); // control chars (keep \n \r \t)
}

// TUI noise patterns ported from renderer-mobile/views/session-view.js
const TUI_LINE_PATTERNS = [
  /bypass\s*permissions/i,
  /tab to cycle/i,
  /new task\?/i,
  /\/clear to save/i,
  /how is claude doing/i,
  /\d+:\s*(Bad|Fine|Good|Dismiss)/,
  /^\d*k?\s*tokens?\s*$/i,
  /^[─━═┈┉⎯⏵⏴\-\s]{4,}$/,         // separator lines (4+ chars)
  /ClaudeMax/i,                       // Claude status bar
  /Smooshing/i,                       // Claude compaction progress
  /Compacting/i,
  /^[>❯]\s*(Research|Searching|Reading|Analyzing|Writing|Editing|Running)/i, // tool status lines
];

function removePromptNoise(str) {
  return str
    .replace(/\r/g, '')
    // Strip (thinking) tags and any garbled content around them
    .replace(/\(thinking\)/g, '')
    // Strip ConPTY rendering artifacts: runs of special symbols mixed with fragments
    .replace(/[★♯●·⏵⏴▶◀▸◂⬢⬡⎡⎤⎣⎦⎯]{2,}/g, '')
    // Strip braille spinners
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, '')
    // Strip progress bars
    .replace(/\[=*>?\s*\]\s*\d+%/g, '')
    // Strip prompt prefixes
    .replace(/^[❯$>%#]\s*/gm, '')
    // Strip lines matching TUI patterns or garbled ConPTY fragments
    .replace(/^.*$/gm, (line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      for (const pat of TUI_LINE_PATTERNS) {
        if (pat.test(trimmed)) return '';
      }
      // Short junk lines: mostly dots/symbols with no real content
      if (trimmed.length < 10 && /^[^a-zA-Z一-鿿]*$/.test(trimmed)) return '';
      // Garble detection: ConPTY fragments have special symbols mixed with short letter runs
      if (trimmed.length >= 3) {
        const symbolCount = (trimmed.match(/[★♯●·⏵⏴▶◀▸◂⬢⬡]/g) || []).length;
        if (symbolCount >= 2) return '';
        const hasCJK = /[一-鿿]/.test(trimmed);
        if (!hasCJK) {
          // For non-CJK lines: detect garbled fragments (e.g. "g...+n+i...hg")
          const words = trimmed.split(/[^a-zA-Z]+/).filter(w => w.length > 0);
          const avgWordLen = words.length > 0 ? words.reduce((a, w) => a + w.length, 0) / words.length : 0;
          if (words.length > 3 && avgWordLen < 3) return '';
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
    const line = lines[i];
    // Prompt boundary: starts with prompt char, or is a blank line followed by content
    if (/^(❯|[$>%#])\s/.test(line) || (/^\s*$/.test(line) && i < lines.length - 2)) {
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
  const lastSentence = truncated.search(/[。.!！?\?\n][^。.!！?\?\n]*$/);
  if (lastSentence > maxLen * 0.5) {
    return truncated.slice(0, lastSentence + 1);
  }
  return truncated;
}

module.exports = { stripAnsi, removePromptNoise, extractLastResponse, smartTruncate };
