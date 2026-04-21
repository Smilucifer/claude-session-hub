# 杰尼龟（Codex / squirtle）团队会话设计

**日期**：2026-04-21
**作者**：Claude (tachibana/claude-mailbox-fix)
**状态**：Draft — 待用户复审
**目标**：让团队里的 Codex 角色（杰尼龟 / squirtle）在输出质量上 ≈ 独立 `codex` CLI 会话

---

## 1. 背景与目标

AI Team Room 三个角色已实现两个：

| 角色 | CLI | 机制 | 等效度 |
|------|-----|------|--------|
| 皮卡丘 | Claude Code | 持久化 PTY + MCP 回调 | ~95% |
| 小火龙 | Gemini CLI | 一次性 `gemini -i` + AfterAgent hook | ~70%（POC 3 证明 persistent PTY 不可行） |
| **杰尼龟** | **Codex CLI** | **本 spec 待实现** | **目标 ~95%** |

Codex 相比 Gemini 的关键差异：**`codex exec resume <session_id>` 官方支持会话续接**。这使"一次性进程 + 跨消息上下文持久化"成为可能，等效度能追齐甚至接近皮卡丘。

### 1.1 非目标

- 不追求超越独立 Codex（团队化必然带来 5% 左右延迟/解析开销）
- 不把 Gemini 改回 Codex 架构（Gemini 已定型为 one-shot 路径）
- 不实现 Codex 的并发、工具审批、图片输入等扩展能力 —— 聚焦聊天等效

### 1.2 成功标准

1. **E2E 两轮对话**：第一轮任意提问收到回复；第二轮提问"请重复你刚刚回复的最后两个字"，返回**字面子串匹配**第一轮最后两字
2. **文件系统证据**：`.codex-sessions/<room>-<char>/` 目录下恰好 1 个 `.jsonl` 文件（证明 resume 复用而不是建新 session）
3. **不污染**：不 kill 用户任何已启动 Hub；分支改动仅限当前 worktree

---

## 2. 架构总览

```
Hub (team-bridge.js)
   │
   ▼
TeamSessionManager.sendMessage(room, character, text)
   │
   ├─ cliKind === 'codex' ─▶ _sendMessageCodex(...)
   │                            │
   │                  priorSid?  ├── no ──▶ spawn codex exec --json --full-auto ... "prompt"
   │                             └── yes ─▶ spawn codex exec resume <sid> --json --full-auto ... "prompt"
   │                            │
   │                            ▼
   │                     解析 stdout JSONL (session.started / item.completed)
   │                            │
   │                            ├─▶ this._codexSessions.set(key, session_id)
   │                            ├─▶ 写 team.db events
   │                            ├─▶ POST /api/team/response
   │                            └─▶ resolve Promise
   │
   └─ Claude / Gemini 路径不变
```

### 2.1 关键设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 进程模式 | `child_process.spawn`（无 PTY） | Codex `exec` 是非交互模式，PTY 反而引入 UI 解析脆弱性 |
| 响应捕获 | stdout `--json` JSONL 流解析 | 上游结构化数据，遵循"解析上游不解析 UI"铁律 |
| 上下文持久化 | `codex exec resume <sid>` 官方机制 | 等效独立 `codex resume --last`，模型基于完整 session state 生成 |
| cwd | `AI_TEAM_DIR`（对齐皮卡丘） | 团队共享工作区，与皮卡丘一致 |
| Persona 注入 | `-c model_instructions_file=<path>`（需 POC 验证）；兜底：首 prompt 前置 `[SYSTEM]` 块 | 干净分离 system/user 消息 |
| Session 文件位置 | `-c sessions.dir=<AI_TEAM_DIR>/.codex-sessions/<room>-<char>/`（需 POC 验证） | 不污染用户 `codex resume --last` picker |
| MCP 工具 | 走全局 `~/.codex/config.toml` 里的 `[mcp_servers.ai-team]`（已配置） | 复用用户已就绪的环境 |
| hook 机制 | Codex 无 hook；由 Node 侧直接写 team.db + POST 回调 | 比 Gemini AfterAgent 更简单 |
| 并发 | 同 key 一次最多一个 in-flight（与皮卡丘一致）；不同 key 天然并发 | SQLite WAL 容忍 |
| 错误语义 | resume 失败不自动重试，清 sid 报错上抛 | 等效原生 Codex（不悄悄降质） |
| 超时后 sid | 保留（等效原生：Ctrl+C 后 session 文件仍在） | 用户语义一致 |
| 关房间 sid | 保留（等效原生：关终端不删 session） | 用户语义一致 |

---

## 3. 文件改动清单

### 3.1 修改

**`core/team-session-manager.js`**
- 解开 `ensureSession` 里 `cliKind === 'codex'` 的 throw
- 新增 `_sendMessageCodex(roomId, characterId, text, timeout)`
- 新增 `_writeCodexPersona(roomId, character)` 辅助函数
- 新增 `_ensureCodexSessionDir(roomId, character)` 辅助函数
- 新增 `_writeTeamDbEvent(roomId, actor, content)` 共用辅助（从 Gemini 路径提成）
- 新增 `_postHubCallback(roomId, actor, content)` 共用辅助
- 新增 `_codexSessions: Map<"room:char", session_id>` 实例字段
- 新增 `_codexProcs: Map<"room:char", ChildProcess>` 实例字段
- 在 `closeRoom` / `closeAll` 里 kill `_codexProcs`（不清 `_codexSessions`）

### 3.2 新增

- `tests/poc-codex-resume.js` — 前置 POC，CLI 层验证三件事（见 §6.1）
- `tests/tachibana-e2e-codex.js` — 严格 E2E，新建隔离 Hub 做两轮 resume（见 §6.2）
- `docs/superpowers/specs/2026-04-21-codex-squirtle-design.md` — 本 spec

### 3.3 不动

- `core/session-manager.js`（Codex 不走 PTY）
- Hub frontend
- `ai-team-tachibana/ai_team/mcp_server/tools_team_comm.py`（`AI_TEAM_DIR` env 已在 Gemini 阶段加过）
- `~/.codex/config.toml`（全局配置，已就绪）
- 其他 worktree / master 分支 / 另一个 Claude 的 `feature/team-mcp-mailbox` 分支

---

## 4. 详细实现

### 4.1 `ensureSession` 新分支

```js
} else if (cliKind === 'codex') {
  this._writeCodexPersona(roomId, character);
  this._ensureCodexSessionDir(roomId, character);
  this._characters.set(key, character);
  this._sessions.set(key, 'codex-deferred');
  return 'codex-deferred';
}
```

### 4.2 `_sendMessageCodex`

伪代码（完整代码见实施阶段）：

```js
async _sendMessageCodex(roomId, characterId, text, timeout = 300000) {
  const key = `${roomId}:${characterId}`;
  if (this._pending.has(key)) throw new Error(`Already waiting for ${key}`);

  const personaFile  = path.join(AI_TEAM_DIR, '.codex-personas', `${roomId}-${characterId}.md`);
  const sessionsDir  = path.join(AI_TEAM_DIR, '.codex-sessions', `${roomId}-${characterId}`);
  const priorSid     = this._codexSessions.get(key);

  const args = ['exec'];
  if (priorSid) args.push('resume', priorSid);
  args.push('--json', '--full-auto',
            '-c', `model_instructions_file=${personaFile}`,
            '-c', `sessions.dir=${sessionsDir}`,
            text);

  const env = this._buildCodexEnv(roomId, characterId);
  const proc = child_process.spawn('codex', args, {
    cwd: AI_TEAM_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  this._codexProcs.set(key, proc);

  return new Promise((resolve, reject) => {
    let stdoutBuf = '', stderrBuf = '';
    let finalText = '', capturedSid = null;

    proc.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf-8');
      let nl;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (!capturedSid && ev.type === 'session.started' && ev.session_id)
          capturedSid = ev.session_id;
        if (ev.type === 'item.completed' && ev.item?.type === 'message' && typeof ev.item.text === 'string')
          finalText = ev.item.text;
      }
    });

    proc.stderr.on('data', (chunk) => { stderrBuf += chunk.toString('utf-8'); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      this._codexProcs.delete(key);
      this._pending.delete(key);
      reject(new Error(`codex exec timeout after ${timeout}ms for ${key}`));
    }, timeout);

    this._pending.set(key, { resolve, reject, timer });

    proc.on('close', (code) => {
      clearTimeout(timer);
      this._codexProcs.delete(key);
      this._pending.delete(key);

      if (code !== 0 || !finalText) {
        // 检测 resume 失败特征
        if (priorSid && /session not found|cannot resume/i.test(stderrBuf)) {
          this._codexSessions.delete(key);
          console.warn(`[codex] resume failed for ${key}, sid cleared`);
        }
        reject(new Error(`codex exec exit=${code} finalText.len=${finalText.length} stderr.tail=${stderrBuf.slice(-400)}`));
        return;
      }

      if (capturedSid && !priorSid) this._codexSessions.set(key, capturedSid);

      this._writeTeamDbEvent(roomId, characterId, finalText);
      this._postHubCallback(roomId, characterId, finalText);
      resolve({ content: finalText });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      this._codexProcs.delete(key);
      this._pending.delete(key);
      reject(err);
    });
  });
}
```

### 4.3 `_buildCodexEnv`（白名单式 env）

```js
_buildCodexEnv(roomId, characterId) {
  return {
    PATH:       process.env.PATH,
    USERPROFILE:process.env.USERPROFILE,
    HOMEDRIVE:  process.env.HOMEDRIVE,
    HOMEPATH:   process.env.HOMEPATH,
    TEMP:       process.env.TEMP,
    TMP:        process.env.TMP,
    HTTP_PROXY:  process.env.HTTP_PROXY  || 'http://127.0.0.1:7890',
    HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7890',
    NO_PROXY:    process.env.NO_PROXY    || '127.0.0.1,localhost',
    PYTHONUTF8: '1',
    AI_TEAM_DIR,
    AI_TEAM_ROOM_ID: roomId,
    AI_TEAM_CHARACTER_ID: characterId,
    AI_TEAM_HUB_CALLBACK_URL: `http://127.0.0.1:${this._hookPort}`,
  };
}
```

显式**不透传**：`CLAUDE_CODE_*` / `GEMINI_*` / `DEBUG` / 所有用户 shell 自定义 env。

### 4.4 Persona 文件模板

**对齐皮卡丘 / 小火龙现有做法**：从 `character.personality` 字段（已定义在 `characters/gamma.yaml` 等 yaml 里）动态拼装，不写死 persona 文本。模板结构与 `_writePromptFile` / `_writeGeminiConfig` 保持一致，只替换"响应捕获规则"那句。

```js
_writeCodexPersona(roomId, character) {
  fs.mkdirSync(CODEX_PERSONAS_DIR, { recursive: true });
  const filePath = path.join(CODEX_PERSONAS_DIR, `${roomId}-${character.id}.md`);
  const personality = character.personality || '';
  const displayName = character.display_name || character.id;
  const content = [
    `# ${displayName} — AI Team Room`,
    '',
    `你是 ${displayName}，一个 AI 团队成员。`,
    '',
    personality ? `## 性格\n${personality.trim()}\n` : '',
    `## 团队协作规则`,
    '',
    `- 你在房间 ${roomId} 中与其他 AI 角色协作讨论。`,
    `- 收到队友或用户的消息后，认真思考并给出你的观点。`,
    `- 保持你的角色特征和说话风格一致。`,
    '',
    `[重要] 认真回答即可。系统会解析你的 stdout 输出发给队友，无需额外操作。`,
  ].join('\n');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}
```

其中：
- `CODEX_PERSONAS_DIR = path.join(AI_TEAM_DIR, '.codex-personas')`
- `character.personality` 从 characters/gamma.yaml 等文件 load 而来，当前 `squirtle` 的 personality 已有完整定义（扎实可靠的全能型选手 / 审视问题客观公正 / 团队的后盾 ...）
- 结尾"系统会解析你的 stdout 输出发给队友" —— 和 Gemini 的"系统会自动捕获"等价但机制不同（Codex 没 hook，走 JSONL stdout）

### 4.5 写 team.db 事件

```js
_writeTeamDbEvent(roomId, actor, content) {
  const db = new DatabaseSync(path.join(AI_TEAM_DIR, 'team.db'));
  try {
    db.prepare(
      "INSERT INTO events (room_id, actor, kind, content, ts) VALUES (?, ?, 'message', ?, ?)"
    ).run(roomId, actor, content, String(Math.floor(Date.now() / 1000)));
  } finally { db.close(); }
}
```

### 4.6 POST 回调给 Hub

```js
_postHubCallback(roomId, actor, content) {
  const body = JSON.stringify({ room_id: roomId, character_id: actor, content });
  const url = new URL(`http://127.0.0.1:${this._hookPort}/api/team/response`);
  const req = http.request({
    hostname: url.hostname, port: url.port, path: url.pathname,
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => {});
  req.on('error', (e) => console.warn(`[codex] hub callback error: ${e.message}`));
  req.write(body); req.end();
}
```

### 4.7 在 `sendMessage` 入口分派

```js
// 在既有的 if (hubSessionId === 'gemini-deferred') 分支后追加：
if (hubSessionId === 'codex-deferred') {
  return this._sendMessageCodex(roomId, characterId, text, timeout);
}
```

### 4.8 在 `closeRoom` / `closeAll` 里杀进程

```js
// closeRoom 遍历时追加：
const p = this._codexProcs.get(key);
if (p) { try { p.kill('SIGKILL'); } catch {} this._codexProcs.delete(key); }
// 不删 this._codexSessions.get(key)
```

---

## 5. 错误处理矩阵

| 场景 | 检测 | 处理 |
|------|------|------|
| Codex 二进制不在 PATH | `spawn error: ENOENT` | reject，提示安装 `npm i -g @openai/codex` |
| 首次 exec 返回非零 | `close event code !== 0` | reject，stderr.tail 入日志 |
| resume 失败（session 损坏） | `stderr` 含 `session not found\|cannot resume` | 清 `_codexSessions[key]`，reject，不自动重试 |
| 无 `item.completed` message | `finalText === ''` | reject，dump 最后 1KB stdout |
| JSONL 解析错（warning 混入） | try/catch 每行 | 忽略非 JSON 行，不影响主流程 |
| 超时 | `setTimeout` | `kill('SIGKILL')`，reject；保留 sid |
| 同 key 重入 | `_pending.has(key)` | reject `Already waiting` |
| 房间关闭 | `closeRoom` | `proc.kill`，保留 sid |
| 子进程崩溃 | `proc.on('error')` | reject，错误上抛 |

---

## 6. 测试策略

### 6.1 前置 POC（`tests/poc-codex-resume.js`）

不走 Hub、不走 team-bridge，纯 Node + `child_process.spawn('codex', ...)`。**三件事任一失败立即停工汇报**。

**POC-1：Persona 注入**
```
prompt: "你是谁？用一句话介绍自己。"
期望回答包含 "杰尼龟" 或 "squirtle" 或 "审慎" 关键词
失败降级：首 prompt 前置 [SYSTEM] 文本块
```

**POC-2：Session 文件隔离**
```
跑一次 exec
断言：AI_TEAM_DIR/.codex-sessions/poc-codex/ 下出现新 .jsonl
断言：~/.codex/sessions/ 下没有新增（对比跑前后快照）
失败降级：接受全局 sessions 污染（选项 B），或探索 --profile 隔离（选项 C）
```

**POC-3：Resume 保留 context**
```
Round1 prompt: "请记住:我的幸运数字是 42。回答'已记住'。"
抓 session_id
Round2 prompt: "我的幸运数字是多少？只答数字。"  (使用 resume <sid>)
断言：Round2 回答包含 "42"
失败：A 方案根本不成立 —— 停工，重新评估 B/C 方案
```

### 6.2 E2E（`tests/tachibana-e2e-codex.js`）

基础设施（沿用 gemini E2E 脚本）：
- CDP 端口：**9232**（不撞 gemini 9231 / claude 9230 / 用户生产 Hub）
- Hub data dir：`C:\temp\hub-tachibana-data-codex`
- AI_TEAM_DIR：`C:\Users\lintian\ai-team-tachibana`
- Hub spawn 为 detached，**脚本结束不关 Hub**（只打印端口/路径让用户自行处理）

**Phase 0：环境准备**
- team.db 清 `room='e2e-codex'` 的 events
- `INSERT OR IGNORE` 确保 rooms 表有 `e2e-codex`
- 确保 characters 表有 `squirtle` 且 `backing_cli='codex'`

**Phase 1：启动隔离 Hub**
- spawn `electron.exe` + `--remote-debugging-port=9232` + env 隔离
- 轮询 `/json/list` 直到 webContents 就绪（30s timeout）

**Phase 2：UI 进入房间**
- CDP 连接
- Runtime.evaluate 点击 AI Team Room tab → 进入 `e2e-codex` 房间
- 截图：`round0-entered.png`

**Phase 3：第一轮对话**
- 在输入框打字：`@squirtle 请推荐一个 Python json 解析库，只答库名一个词`
- Enter 提交
- 轮询 team.db：等 `room='e2e-codex' actor='squirtle' kind='message' rowid > baseline`（120s timeout）
- 记 `firstRowId`、`firstContent`
- 截图：`round1-replied.png`
- **断言 1**：`firstContent` 非空 ≥ 1 字

**Phase 4：第二轮对话（resume 验证）**
- 输入：`@squirtle 请重复你刚刚回复的最后两个字,只答那两个字`
- Enter
- 轮询 team.db：`rowid > firstRowId`（120s timeout）
- 记 `secondRowId`、`secondContent`
- 截图：`round2-replied.png`
- **断言 2**：`secondContent` 包含 `firstContent.slice(-2)` 作为子串

**Phase 5：文件系统验证**
- **断言 3**：`AI_TEAM_DIR/.codex-sessions/e2e-codex-squirtle/` 存在
- **断言 4**：该目录下 `.jsonl` 文件恰好 1 个
- **断言 5**：该 `.jsonl` 文件大小 > 2KB（粗略证明累积了两轮完整 conversation state）

**Phase 6：诊断与退出**
- 成功：打印三张截图路径 + Hub 端口/data dir 提示
- 失败：dump team.db 最近 20 条 events + `.codex-sessions` 目录清单 + Hub devtools console 日志 + Codex stderr tail（从 manager 日志里取）
- **不关 Hub**

### 6.3 测试不覆盖的范围

- ❌ 多角色并发（皮卡丘 + 杰尼龟同时回复）
- ❌ 工具调用端到端（squirtle 实际调 `team_list_rooms`）
- ❌ 超时 / resume 失败 fallback 路径
- ❌ 非 ASCII prompt 边界
- ❌ 极长 prompt / 极长回复

这些留给单元测试或后续集成测试，E2E 聚焦"杰尼龟 ≈ 独立 Codex"的核心证据。

---

## 7. 分支与 Hub 操作约束

### 7.1 分支

- **仅改动**：`hub-tachibana` worktree（分支 `tachibana/claude-mailbox-fix`）+ `ai-team-tachibana` worktree
- **不动**：master / 另一个 Claude 的 `feature/team-mcp-mailbox` 分支 / 任何其他 worktree
- 所有 commit 留在本地，等用户验收后再考虑 push

### 7.2 Hub 实例

- **不 kill**：用户任何已启动的 Hub（生产 / 其他测试 / 其他 Claude 的 Hub）
- **只新建**：E2E 每次新开一个 9232 端口 + `C:\temp\hub-tachibana-data-codex` data dir 的 Hub
- **不自动关**：测试完 Hub 保留，脚本打印端口/路径，用户自行关

### 7.3 文件清理

- **不清**：`.codex-personas/` / `.codex-sessions/` / Hub data dir / worktree
- **清**：测试脚本自造的临时 prompt 文件（如有）

---

## 8. 开放问题与风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| `-c model_instructions_file` 可能已废弃（记忆里的旧 API 可能失效） | 中 | POC-1 前置验证；失败时切首 prompt 前置 `[SYSTEM]` 块 |
| `-c sessions.dir` config key 名不确定 | 中 | POC-2 验证；失败时接受全局污染或换 `--profile` |
| Codex `--json` 事件字段名猜测 | 中 | POC-3 时打印完整 JSONL，根据真实字段修正代码 |
| Codex Windows 多会话内存泄漏（旧记忆） | 低 | A 方案每次 fresh exec 天然缓解 |
| session jsonl 被中途 kill 半写 | 低 | 先保留 sid，下次 resume 失败走 C3 清 sid 路径 |
| `~/.codex/config.toml` 全局 MCP 配置被用户改动 | 低 | 启动时读一遍 config.toml 看是否还有 `[mcp_servers.ai-team]`，缺失则告警 |

---

## 9. 实施顺序（建议）

1. **POC** — `tests/poc-codex-resume.js`，验证 3 个假设，失败立即停工汇报
2. **核心实现** — `_sendMessageCodex` + helpers
3. **单元层自测** — 直接 `node -e` 调 `_sendMessageCodex`，确认 stdout 解析和 team.db 写入
4. **E2E** — `tests/tachibana-e2e-codex.js`，通过则 spec 目标达成
5. **commit** — 单独 commit，消息含 "Codex team session (A/exec+resume approach)"

---

## 10. 完成定义（DoD）

- [ ] POC-1/2/3 全部通过或记录了降级方案
- [ ] E2E 断言 1-5 全部通过
- [ ] 三张截图证据归档
- [ ] 所有改动只在 `hub-tachibana` + `ai-team-tachibana` worktree
- [ ] 用户任何已启动的 Hub 未被打断
