// tests/_test-ring-buffer-noise.js
// Paste into Hub DevTools console (Ctrl+Shift+I) to dump ring buffer noise analysis.

(async function analyzeRingBufferNoise() {
  const { ipcRenderer } = require('electron');
  const meetings = await ipcRenderer.invoke('get-meetings');
  console.log('Found', meetings.length, 'meetings');

  for (const m of meetings) {
    console.log(`\n=== Meeting: ${m.title} (${m.subSessions.length} subs) ===`);
    for (const sid of m.subSessions) {
      const session = sessions.get(sid);
      const label = session ? (session.title || session.kind) : 'unknown';
      const raw = await ipcRenderer.invoke('get-ring-buffer', sid);
      if (!raw) { console.log(`  [${label}] empty buffer`); continue; }

      // Basic ANSI strip only
      const stripped = raw
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\][^\x07\x1b]*/g, '')
        .replace(/\x1b[()][AB012]/g, '')
        .replace(/\x1b[=>Nc7-9]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
        .replace(/\r/g, '');

      console.log(`\n  [${label}] raw=${raw.length} stripped=${stripped.length}`);
      console.log('--- STRIPPED LAST 3000 ---');
      console.log(stripped.slice(-3000));
      console.log('--- END STRIPPED ---');

      const quick = await ipcRenderer.invoke('quick-summary', sid);
      console.log(`  [${label}] L0 len=${quick.length}`);
      console.log('--- L0 RESULT ---');
      console.log(quick);
      console.log('--- END L0 ---');
    }
  }
})();
