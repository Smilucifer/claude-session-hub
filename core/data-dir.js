const path = require('path');
const os = require('os');

// Resolve the Hub's data directory root.
// Honors CLAUDE_HUB_DATA_DIR env var so parallel test instances can isolate
// state.json / mobile-devices / images without touching the production Hub.
// Default: ~/.claude-session-hub (unchanged production path).
function getHubDataDir() {
  const override = process.env.CLAUDE_HUB_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), '.claude-session-hub');
}

module.exports = { getHubDataDir };
