// Mock fixtures for the mobile test harness.
// Includes realistic Claude Code terminal output with tables, box-drawing,
// long paragraphs, markdown, and the TUI prompt chrome — so we can validate
// the mobile renderer against content that used to render badly.

const now = Date.now();

const SESSIONS = [
  {
    id: 'sess-remote',
    title: '远程桌面',
    kind: 'claude',
    cwd: 'C:\\Users\\lintian\\claude-session-hub',
    pinned: true,
    lastMessageTime: now - 3 * 60 * 1000,
    lastOutputPreview: '我已完成手机端 PWA 的移动端远程访问设计...',
    unreadCount: 2,
    model: 'opus',
    status: 'idle',
  },
  {
    id: 'sess-review',
    title: '代码审查',
    kind: 'claude',
    cwd: 'C:\\Users\\lintian\\LinDangAgent',
    pinned: false,
    lastMessageTime: now - 17 * 60 * 1000,
    lastOutputPreview: '审查完成，发现 3 处潜在问题，已生成补丁建议',
    unreadCount: 0,
    model: 'sonnet',
    status: 'idle',
  },
  {
    id: 'sess-long',
    title: '长输出压测',
    kind: 'claude',
    cwd: 'C:\\tmp',
    pinned: false,
    lastMessageTime: now - 1 * 60 * 1000,
    lastOutputPreview: '300 行滚动压力测试内容...',
    unreadCount: 0,
    model: 'opus',
    status: 'idle',
  },
  {
    id: 'sess-stock',
    title: '兆易创新 深度研报',
    kind: 'claude-resume',
    cwd: 'C:\\LinDangAgent',
    pinned: false,
    lastMessageTime: now - 2 * 3600 * 1000,
    lastOutputPreview: '结论：中性偏多，目标价 68.5 元，风险点 3 条',
    unreadCount: 0,
    model: 'sonnet',
    status: 'idle',
  },
  {
    id: 'sess-l2o',
    title: 'L2O_Sim 校准',
    kind: 'claude',
    cwd: 'C:\\L2O_Sim',
    pinned: false,
    lastMessageTime: now - 26 * 3600 * 1000,
    lastOutputPreview: '校准曲线已经与外场采样对齐，残差 < 1.2 dB',
    unreadCount: 1,
    model: 'opus',
    status: 'idle',
  },
];

// A chunk of ANSI-flavoured output that mirrors a typical Claude Code session:
// greeting, markdown answer, a Unicode box-drawing table, a code block, and
// the TUI prompt line at the bottom. Tables are the main regression target —
// the old TUI-hiding regex used to erase them.
const REMOTE_BUFFER = [
  '\x1b[36m●\x1b[0m 你好，我已经把手机端远程访问的设计文档生成好了。',
  '',
  '下面是这次要落地的关键模块对照表：',
  '',
  '\x1b[90m┌──────────────────┬───────────────┬─────────────────────────────┐\x1b[0m',
  '\x1b[90m│\x1b[0m 模块             \x1b[90m│\x1b[0m 状态          \x1b[90m│\x1b[0m 备注                        \x1b[90m│\x1b[0m',
  '\x1b[90m├──────────────────┼───────────────┼─────────────────────────────┤\x1b[0m',
  '\x1b[90m│\x1b[0m mobile-server    \x1b[90m│\x1b[0m \x1b[32m已完成\x1b[0m        \x1b[90m│\x1b[0m Express + ws，端口 3470     \x1b[90m│\x1b[0m',
  '\x1b[90m│\x1b[0m mobile-auth      \x1b[90m│\x1b[0m \x1b[32m已完成\x1b[0m        \x1b[90m│\x1b[0m token 生成 / 校验 / 撤销    \x1b[90m│\x1b[0m',
  '\x1b[90m│\x1b[0m renderer-mobile  \x1b[90m│\x1b[0m \x1b[33m进行中\x1b[0m        \x1b[90m│\x1b[0m 折叠屏布局 + 输入条适配     \x1b[90m│\x1b[0m',
  '\x1b[90m│\x1b[0m pair.html        \x1b[90m│\x1b[0m \x1b[32m已完成\x1b[0m        \x1b[90m│\x1b[0m 二维码 + localStorage       \x1b[90m│\x1b[0m',
  '\x1b[90m│\x1b[0m service-worker   \x1b[90m│\x1b[0m \x1b[33m进行中\x1b[0m        \x1b[90m│\x1b[0m 仅缓存静态壳                \x1b[90m│\x1b[0m',
  '\x1b[90m│\x1b[0m 真机联调         \x1b[90m│\x1b[0m \x1b[31m未开始\x1b[0m        \x1b[90m│\x1b[0m Mate X6 内外屏              \x1b[90m│\x1b[0m',
  '\x1b[90m└──────────────────┴───────────────┴─────────────────────────────┘\x1b[0m',
  '',
  '对应的协议消息我写成了一个 \x1b[1m统一枚举\x1b[0m，便于前后端共享：',
  '',
  '\x1b[90m```js\x1b[0m',
  'const MSG = {',
  '  SESSION_LIST: "session-list",',
  '  SESSION_UPDATED: "session-updated",',
  '  OUTPUT: "output",',
  '  PERMISSION: "permission-prompt",',
  '  INPUT: "input",',
  '  SUBSCRIBE: "subscribe",',
  '};',
  '\x1b[90m```\x1b[0m',
  '',
  '下一步建议：',
  '  1. 跑一遍 \x1b[36mnpm run test\x1b[0m 看看单元测试是否覆盖所有 ws 分支',
  '  2. 开第二个 Electron 实例实测配对流程',
  '  3. 在 Mate X6 外屏 / 内屏分别验证布局',
  '',
  '如果确认方案，我可以直接开始实现。',
  '',
].join('\r\n') + '\r\n' +
'\r\n' +
'\x1b[2m─'.repeat(60) + '\x1b[0m\r\n' +
'\x1b[90m >\x1b[0m \r\n';

// Short conversation that ends with a scrollable summary table
const REVIEW_BUFFER = [
  '\x1b[36m●\x1b[0m 审查完成，扫描 12 个文件，发现以下问题：',
  '',
  '\x1b[31m[!]\x1b[0m core/session-manager.js:142 PTY 错误事件未绑定监听器',
  '\x1b[33m[?]\x1b[0m renderer/renderer.js:877 资源在切换时未正确释放',
  '\x1b[33m[?]\x1b[0m core/mobile-auth.js:54 token 撤销后未广播给活跃 ws',
  '',
  '补丁建议：',
  '\x1b[32m+\x1b[0m  sessionManager.on("error", (err) => log.error(err));',
  '\x1b[31m-\x1b[0m  // TODO: wire up error handler',
  '',
  '你想让我先修复哪一个？',
  '',
  '\x1b[90m >\x1b[0m \r\n',
].join('\r\n');

// Long session for stress-testing scrollback — 300 lines of varied content
const LONG_BUFFER = Array.from({ length: 300 }, (_, i) => {
  if (i % 30 === 0) return `\x1b[36m●\x1b[0m 段落 ${i / 30 + 1}: 测试上翻滚动的中文内容，编号 ${i + 1}`;
  if (i % 13 === 0) return `\x1b[90m────── 分割线 ${i} ──────\x1b[0m`;
  return `行 ${String(i + 1).padStart(3, '0')}: 这是滚动压力测试的第 ${i + 1} 行，用来验证用户能否一路翻到最早的输出`;
}).join('\r\n') + '\r\n\x1b[90m >\x1b[0m \r\n';

const BUFFERS = {
  'sess-remote': REMOTE_BUFFER,
  'sess-review': REVIEW_BUFFER,
  'sess-long':   LONG_BUFFER,
  'sess-stock': '\x1b[36m●\x1b[0m 兆易创新研报已生成，摘要已发邮件。\r\n\r\n\x1b[90m >\x1b[0m \r\n',
  'sess-l2o':   '\x1b[36m●\x1b[0m 校准完成，残差 1.18 dB。\r\n\r\n\x1b[90m >\x1b[0m \r\n',
};

module.exports = { SESSIONS, BUFFERS };
