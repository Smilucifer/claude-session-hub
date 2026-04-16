const fs = require('fs');
const path = require('path');

function directoryExists(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function loadAppConfig({
  configPath = path.join(__dirname, '..', 'config', 'session-hub.json'),
  fallbackDirectory = process.env.USERPROFILE || process.env.HOME || '.',
} = {}) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    parsed = {};
  }

  const configured = parsed && typeof parsed.defaultWorkingDirectory === 'string'
    ? parsed.defaultWorkingDirectory.trim()
    : '';

  return {
    defaultWorkingDirectory: directoryExists(configured) ? configured : fallbackDirectory,
  };
}

function getDefaultWorkingDirectory(opts = {}) {
  return loadAppConfig(opts).defaultWorkingDirectory;
}

module.exports = {
  loadAppConfig,
  getDefaultWorkingDirectory,
  directoryExists,
};
