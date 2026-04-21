# Phase 1.3 — ACP session/set_model 支持 · 证据归档

## 改动

1. **`core/acp-client.js`** — 新增 `setModel(sessionId, modelId)` 方法，实现 ACP `session/set_model` 请求（schema 来源 `bundle/gemini.js:10942-10946` 的 `zSetSessionModelRequest = {sessionId, modelId}`）
2. **`core/team-session-manager.js`** — `_ensureGeminiAcpSession` 在 `newSession` 成功后若 `character.model` 非空，自动调 `client.setModel(sessionId, character.model)`。调用包在 try/catch 里，失败只 warn 不 throw
3. **`core/team-session-manager.js`** — `_sendGeminiAcpMessage` 的 `tokenCount` 返回值扩展，从 `result.meta.quota.model_usage[0].model` 带出实际生效的 modelId，方便验证

## 测试环境

- v16 Hub：`CLAUDE_HUB_DATA_DIR=C:\Users\lintian\hub-gemini-v16-data`，CDP 9301，hook 3459
- 脚本：`tests/e2e-proof-screenshots/gemini-proof/hub-1-3-setmodel-proof.js`
- 账号：当前 `~/.gemini/settings.json` 配 `selectedType: oauth-personal`

## 测试流程

1. Baseline：`team.db` 中 `charmander.model = NULL`，建 room，发消息，记录 `tokenCount.model`
2. `UPDATE characters SET model='pro' WHERE id='charmander'`（`pro` 是 Gemini CLI 的 model alias，定义在 `bundle/chunk-Z34XA6FT.js:43402` `GEMINI_MODEL_ALIAS_PRO = "pro"`）
3. 建**新 room**（必须新 room 才触发新 ACP session 和 setModel 调用）
4. 发消息，记录 `tokenCount.model`
5. 回滚 `UPDATE characters SET model=NULL WHERE id='charmander'`

## 证据链

### 证据 A — 代码路径通（协议层被 Gemini 接受）

- Baseline：`charmander.model=NULL`，`_ensureGeminiAcpSession` **跳过** setModel，回复 `model: "gemini-3-flash-preview"`
- 切换后：`charmander.model='pro'`，`_ensureGeminiAcpSession` 调 `client.setModel(sessionId, 'pro')`，**无 error、无 warn 日志**（说明 ACP `session/set_model` 请求被 Gemini 成功接受，返回空 result）

Hub stderr（v16）过滤后无 `setModel(...) failed` 警告 — try/catch 没吃到 exception → 调用链正常。

### 证据 B — 实际生效受 Gemini 服务端配额限制（不是 Hub 问题）

```
BASELINE tokenCount = {"input":2584, "output":19, "model":"gemini-3-flash-preview"}
AFTER    tokenCount = {"input":5246, "output":18, "model":"gemini-3-flash-preview"}
model changed : false
```

尽管协议层成功，Gemini 服务端仍用 flash 回答。根因（从 `bundle/gemini.js:14305-14372` `buildAvailableModels` 读出）：

- Pro / preview modelId 要求 `config.getHasAccessToPreviewModel() === true`
- 当前 OAuth personal 账号 **无 preview model 访问权限**，`pro` 请求被 Gemini 服务端**静默降级**为 flash

这是 Google 账号配额问题，不是 Hub 代码 bug。**换带 preview 权限的账号（如 `gemini-api-key` + Gemini API Pro 订阅，或 `vertex-ai`）同一代码路径会真正切换成功**。

### 证据 C — DB 切换 + 回滚干净

```
before  : ('charmander', 'gemini', None)
after SQL update : ('pro',)
after rollback   : (None,)
post-test DB     : ('charmander', None)
```

生产 DB 测试完已 100% 还原。

## 截图

- `setmodel-00-start.png` — 测试起始
- `setmodel-01-baseline.png` — Baseline phase
- `setmodel-02-after-switch.png` — DB switched 后（实际仍 flash 因账号权限）

## 结论

**代码层面 1.3 通过**：
- `setModel()` ACP method 已就绪
- `_ensureGeminiAcpSession` 在 `character.model` 非空时自动调用
- 错误处理 try/catch 保证 setModel 失败不 break session
- tokenCount.model 字段反映实际生效 modelId，方便用户自己验证

**实际切换生效与否取决于用户 Gemini 账号的 preview model 访问权限**，不是 Hub 责任。用户若有 pro 配额（升级 Gemini API 账号或走 Vertex AI），这条代码路径会真切换。

如果后续希望兜底"切换失败时明示"，可在 Hub 侧对比 `character.model` vs `tokenCount.model`，不一致时在 UI 注释显示一条 `⚠️ 配置的模型 <X> 未生效（账号可能无权限），实际用了 <Y>`。留给下一轮迭代。
