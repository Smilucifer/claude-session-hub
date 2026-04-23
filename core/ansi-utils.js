// core/ansi-utils.js

function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[()][AB012]/g, '')
            .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function removePromptNoise(str) {
  return str
    .replace(/^[❯$>%#]\s*/gm, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷]/g, '')
    .replace(/\[=*>?\s*\]\s*\d+%/g, '')
    .replace(/^\s*\n/gm, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\r/g, '')
    .trim();
}

function extractLastResponse(cleaned) {
  const lines = cleaned.split('\n');
  let lastBoundary = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^(❯|[$>%#])\s/.test(line) || /^\s*$/.test(line) && i < lines.length - 2) {
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
