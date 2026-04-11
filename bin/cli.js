#!/usr/bin/env node

// Claude Session Hub - CLI entry point
// Usage: npx claude-session-hub

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// In production, run the built server
// In dev, use tsx to run TypeScript directly
async function main() {
  const serverPath = resolve(__dirname, '../dist/server/index.js');
  try {
    await import(serverPath);
  } catch (e) {
    // Fallback: try running from source with tsx
    console.error('Built files not found. Run "npm run build" first, or use "npm run dev" for development.');
    process.exit(1);
  }
}

main();
