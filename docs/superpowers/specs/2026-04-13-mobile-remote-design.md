# Claude Session Hub 移动端远程访问 —— 设计文档

**日期**: 2026-04-13
**作者**: 立花道雪 × Claude (brainstorming skill)
**状态**: Draft (awaiting user review)
**目标仓库**: `C:\Users\lintian\claude-session-hub`

---

## 1. 背景与目标

### 1.1 问题陈述

用户通过手机 RDP 远程桌面到一台 Windows 工作站使用 Claude Session Hub，但手机屏幕尺寸（华为 Mate X6 折叠屏）和桌面分辨率不匹配，无论外屏还是内屏，RDP 传回的像素都是对桌面画面的缩放，文字过小、触屏按钮过小，体验差。

### 1.2 目标（MVP）

让用户能在手机（华为 Mate X6 折叠屏）上**以手机原生 UI** 远程操作桌面的 Claude Session Hub：
1. 查看所有 Claude 会话列表、未读状态、最新 AI 回复预览
2. 进入任一会话查看实时终端输出
3. 向任一会话发送 prompt（支持中文 IME）
4. 快捷响应 Claude 的 permission prompt（一键允许/拒绝）
5. 在**内网和公网（通过 Tailscale）**下均可使用
6. 折叠屏两种形态（外屏窄竖、内屏宽屏）均自适应

### 1.3 非目标（MVP 不做）

- 手机端新建/关闭/重启 session（保留在电脑端操作）
- Web Push 推送通知（用现有 Hook 对接企业微信机器人等替代）
- 原生 App / Capacitor APK 打包（二期按需）
- iOS 深度兼容（一期以华为 Mate X6 为主要测试设备）
- 语音输入、拍照粘贴、多媒体
- 离线查看历史 session

---

## 2. 用户体验

### 2.1 首次配对流程（人在电脑旁做一次，永久有效）

1. 用户在桌面 Electron Hub 右上角点击 **"手机"** 按钮
2. 弹出配对对话框：
   - 顶部显示内网 IP 二维码（默认）
   - 下方"地址清单"可添加 Tailscale IP / 公网域名 / frp 地址（多个）
   - 提示"请一次填好所有可能用到的地址，以后无需再扫"
3. 用户用手机扫码 → 浏览器打开 PWA
4. PWA 首次加载：
   - 解析 URL 参数 `token` + `addresses[]`
   - 存入 `localStorage`
   - 生成本地 `deviceId`（随机 UUID）
   - POST `/api/devices/register` 告知服务端"我是华为 Mate X6"
5. 用户在 Chrome/鸿蒙浏览器菜单选"添加到主屏幕"→ PWA 图标出现在手机桌面

**此后永久不用再扫码**，除非用户主动撤销设备或清浏览器数据。

### 2.2 日常使用流程（人在公司，电脑在家）

1. 用户点手机桌面 PWA 图标
2. PWA 启动（全屏无浏览器栏，有 splash screen）
3. 前端读 `localStorage` 地址清单 → 并发 `GET /ping?token=xxx` 每个地址（300ms 超时）
4. 首个返回 200 的地址胜出，建立 WS 连接
5. UI 显示会话列表（和桌面 Hub 看到的同一份数据）
6. 用户点进某 session → 全屏终端 + 底部输入条 + 快捷按钮
7. 打字 → 点发送 → 文字 + `\r` 注入 PTY → AI 流式回复 → 手机端实时显示
8. Claude 触发 permission prompt → 手机底部浮出卡片 "Claude 要运行：xxx" + [允许] [拒绝] 大按钮
9. 用户退出 PWA / 息屏 → WS 自动断开，重新打开 PWA 时自动重连 + 断点续传

### 2.3 折叠屏适配

- **外屏（~6.45" 窄竖）**：单列布局，列表页→详情页导航，底部输入条固定
- **内屏（~7.93" 宽屏）**：左侧 35% 常驻会话列表 + 右侧 65% 终端 + 输入条（类桌面 Hub 布局）
- 靠 CSS `@media (min-width: 768px)` 自动切换，折叠开合触发 viewport 变化即可
- 终端字号两套 preset：窄屏 12px / 宽屏 14px

---

## 3. 架构

### 3.1 进程与端口

```
[手机 PWA] ──HTTP+WS──> [电脑 Electron Hub main 进程]
                        ├── sessionManager (PTY 池，已有)
                        ├── hookServer (3456-3460，已有)
                        └── mobileServer (3470，新增)
                            ├── Express 静态服务（HTML/JS/CSS）
                            ├── REST API (/api/*)
                            └── WebSocket (/ws/*)
```

- **单进程**：`mobileServer` 作为 main.js 的子模块挂起来，复用同一 `sessionManager` 实例。关 Hub = 关移动端。
- **端口 3470**：避开已占用的 3456-3460 hook 段。首个可用绑定，冲突时递增到 3479。
- **绑定地址**：`0.0.0.0:3470`，让内网任意接口可达；Tailscale 的 `100.64.x.x` 也自动包含。

### 3.2 模块结构

```
core/
  mobile-server.js         ← 新增：Express + ws 服务入口
  mobile-auth.js           ← 新增：token 生成/校验/设备管理
  mobile-protocol.js       ← 新增：WS 消息编解码
renderer-mobile/           ← 新增：PWA 前端（独立于桌面 renderer/）
  index.html
  manifest.json            ← PWA 配置（名称/图标/主题色/display:standalone）
  service-worker.js        ← 离线缓存壳（仅缓存静态资源，数据仍走网络）
  app.js                   ← 主逻辑
  pair.html                ← 配对落地页（解析 token/addresses 存 localStorage）
  styles/
    list.css               ← 列表页
    session.css            ← 会话页
    responsive.css         ← 折叠屏媒体查询
main.js                    ← 改动：启动时 require('./core/mobile-server').start()
renderer/renderer.js       ← 改动：右上角"手机"按钮 + 配对对话框 UI
```

### 3.3 数据流

**AI 输出路径**（手机看到 AI 打字）：

```
PTY stdout
  → sessionManager.onData (已有)
    → 桌面 renderer IPC (已有)
    → mobileServer 广播给所有订阅该 sessionId 的 WS (新增)
      → 手机 PWA 写入 xterm.js (新增)
```

**用户输入路径**（手机打字 → Claude 看到）：

```
PWA 输入框发送
  → WS 消息 { type: "input", sessionId, data: "text\r" }
    → mobileServer 校验 token + deviceId
      → sessionManager.writeToSession(sessionId, data)
        → PTY stdin
          → Claude CLI 处理
```

**Permission 卡片触发路径**（依赖新增 PreToolUse hook）：

```
Claude CLI 触发 PreToolUse hook (需新增到 ~/.claude/settings.json)
  → session-hub-hook.py 读 stdin 的 tool_name/tool_input/session_id
    → POST /api/hook/permission 到 hookServer (扩展现有 hook server)
      → sessionManager 发 'permission-prompt' 事件 { sessionId, command, description }
        → mobileServer 广播到订阅该 session 的 WS
          → 手机 PWA 浮出卡片
            → 用户点 [允许] → WS 发 { type: "input", data: "1\r" }
              → PTY stdin → Claude TUI 的 permission 行
```

**注意**：现有 Hub 只用 `Stop` + `UserPromptSubmit` 两个 hook，本项目需在 `~/.claude/settings.json` 额外注册 `PreToolUse` hook，并扩展 `session-hub-hook.py` 识别该事件类型分发到新端点。这是本项目对 Hub 现有 hook 架构的**一处侵入性改动**。

---

## 4. 协议

### 4.1 REST API

| 路径 | 方法 | 用途 | 鉴权 |
|------|------|------|------|
| `/api/ping` | GET | 存活探测（PWA 多地址发现用） | token |
| `/api/sessions` | GET | 获取所有 session 列表 | token |
| `/api/sessions/:id/buffer` | GET | 获取 session 最近 8KB 输出（进详情页时回填） | token |
| `/api/devices/register` | POST | 首次配对后 PWA 登记 deviceId + 名称 | token + 一次性配对码 |
| `/api/devices` | GET | 桌面 Hub 读取已配对设备列表 | 本地 UDS only |
| `/api/devices/:id` | DELETE | 撤销某设备 | 本地 UDS only |

### 4.2 WebSocket 协议

**连接握手**：`WS /ws?token=<token>&deviceId=<id>&lastSeq=<n>`
- 服务端校验 token hash 命中 `mobile-devices.json` 某条目 → 建立连接
- 失败 → 关闭 WS，HTTP 1008 Policy Violation

**消息类型（JSON over text frame）**：

客户端 → 服务端：
```
{ type: "subscribe", sessionId: "xxx" }     订阅某 session 的输出
{ type: "unsubscribe", sessionId: "xxx" }
{ type: "input", sessionId, data: "text" }  发输入到 PTY
{ type: "ping" }                             心跳
{ type: "mark-read", sessionId }             标记已读
```

服务端 → 客户端：
```
{ type: "session-list", sessions: [...] }    全量列表（连接后首发）
{ type: "session-updated", session: {...} }  增量更新（含 unread/title/preview）
{ type: "output", sessionId, seq, data }     PTY 输出帧
{ type: "permission-prompt", sessionId, command, description }
{ type: "pong" }
{ type: "error", code, message }
```

每个 `output` 帧带自增 `seq`。断线重连时 WS URL 带 `lastSeq=N`，服务端补发 seq > N 的帧（限 ring buffer 8KB）。

---

## 5. 鉴权与配对

### 5.1 Token 生成与存储

- 首次启动 mobileServer 时生成 32 字节随机 token（256 bit）
- 每次"添加手机设备"都生成一个**独立 token**（允许多设备同时配对，各自可撤销）
- 存 `~/.claude-session-hub/mobile-devices.json`：

```json
{
  "version": 1,
  "devices": [
    {
      "deviceId": "a7f3...",
      "name": "华为 Mate X6",
      "tokenHash": "$2b$...bcrypt...",
      "createdAt": 1744...,
      "lastSeenAt": 1744...,
      "lastIp": "100.64.0.12"
    }
  ]
}
```

- 明文 token 只在配对二维码里出现一次，之后服务端只保存 bcrypt hash
- PWA 侧明文 token 存 `localStorage`（浏览器沙箱保护）

### 5.2 配对 URL 结构

```
http://<addr>:3470/pair?token=<256bit-hex>&addresses=<base64url-json>&name=<url-encoded>
```

其中 `addresses` 是 JSON 数组的 base64url：`["192.168.1.8:3470","100.64.0.5:3470","https://hub.example.com"]`

PWA 的 `pair.html` 解析这些参数 → 存 `localStorage` → 立即 POST `/api/devices/register` 换取"设备已登记"确认 → 跳转 `/` 进入主界面。

**Token 生命周期语义**：
- Token 永久有效，直到用户在桌面 Hub 主动撤销该设备
- 一个 token **只能被一个 deviceId 登记**（首次 register 时绑定），后续其他 deviceId 用同一 token 来 register 会被服务端拒绝（防止 URL 截图泄露后被他人接管）
- 未登记的 token 尝试 WS 握手会被拒（强制要求先走过 `/pair → register` 流程）

### 5.3 多地址自动发现

PWA 启动时：
1. 读 `localStorage.addresses` → 并发 `GET /api/ping` 所有候选
2. 300ms 超时，首个 200 响应胜出
3. 成功连接后，服务端在 `/api/ping` 响应里带 `serverSelfAddrHint`（当前电脑检测到的自己的地址），若与 localStorage 不一致则追加进清单
4. 失败全部 → 显示"所有已知地址均不可达"大红提示

### 5.4 撤销设备

- 桌面 Hub 设置页 → "已配对设备"列表
- 每行显示 name / lastSeenAt / lastIp / [撤销] 按钮
- 撤销 = 从 `mobile-devices.json` 删除该条目 → 后续 WS 握手该 token 查不到 → 401

### 5.5 Tailscale 集成指南（文档）

在 `docs/mobile-tailscale-setup.md` 写一页指南：
1. 电脑：`winget install Tailscale.Tailscale` → 启动并登录
2. 手机：应用市场/AppGallery 下载 Tailscale → 登录同一账号
3. 电脑上跑 `tailscale ip -4` 记下 `100.64.x.x`
4. 首次配对时把这个 IP 填进"地址清单"
5. 完成

---

## 6. 错误处理

| 场景 | 行为 |
|------|------|
| Token 错/过期 | WS 拒握手；PWA 大红字 "设备未注册，请重新扫码" |
| 所有地址不可达 | PWA 红色 banner + 重试按钮（间隔 5s 自动重试） |
| WS 心跳超时（30s 无 pong） | 前端标记断开，指数退避重连（1/2/4/8/最多 30s） |
| PTY 已死（session 退出） | 会话列表卡片变灰，点进去显示 "会话已失效" + 返回列表按钮 |
| 电脑 Hub 关闭 | WS 收到 close → 全屏 toast "电脑端 Hub 已关闭" |
| Ring buffer 溢出（断线太久） | 补发"… [连接中断期间漏了 N 行]" 占位，之后恢复正常帧 |
| Permission 卡片点了拒绝想反悔 | 不支持撤销（Claude CLI 行为限制），提示"请重新发 prompt 让 Claude 再试" |

遵循 `feedback_no_silent_degradation`：一切会影响用户判断的错误必须可见，不静默降级。

---

## 7. 已有机制复用

MVP 大量复用现有 Hub 能力，不重复造轮子：

| 复用组件 | 用途 |
|---|---|
| `sessionManager` | PTY 池、session 状态、ring buffer、onData 事件 |
| `hookServer` | Hook 回调服务 → 本项目**扩展**其处理 `PreToolUse` 事件（新增 endpoint + hook 配置） |
| `hook-event` / `status-event` 事件总线 | 广播到 mobile WS |
| Dormant restore 机制 | 手机端列表看到的 session 集合和桌面完全一致 |
| Preview 生成（CC transcript 优先） | 移动端列表每行的 AI 预览直接用同一字段 |
| unread 计数 | Stop hook → 非活动 session bump，移动端和桌面端共享 |
| Clash 代理强制 | 新会话 env 注入逻辑不变，mobile-server 本身不走外网 |

---

## 8. 测试策略

### 8.1 真实执行（遵循 `feedback_real_testing`）

- **不做 mock 测试冒充通过**
- 后端：启动 mobileServer → 用 Node 脚本/wscat 真实握手、订阅、发 input → 验 PTY 真的收到字符并回输出
- 前端：Chrome DevTools 模拟手机视口 + 真机（Mate X6 内外屏）实测
- 折叠屏：必须在 Mate X6 上开合验证 viewport 切换
- 联调：桌面 Hub + 真手机 PWA 连 WS，端到端 prompt→AI 回复→permission 卡片→允许全流程跑一遍

### 8.2 关键验证点

1. 手机发中文 prompt → Claude 正确收到（不乱码不逐字上屏）
2. Permission 卡片点"允许" → Claude CLI 正确推进
3. 桌面和手机同时打开同一 session → 输出双端实时同步
4. 手机息屏 2 分钟再点亮 → WS 自动重连 + ring buffer 补帧
5. 切换 Wi-Fi（家→公司）→ PWA 自动切换到 Tailscale 地址
6. 撤销设备 → 该手机立刻 401
7. Mate X6 外屏竖屏布局正常 / 展开内屏自动切 35/65 双栏
8. 输入法弹出 → 输入框不被遮挡（viewport-fit 处理过）
9. `chrome://inspect` 能远程调试手机上的 PWA

---

## 9. 范围边界

### 9.1 MVP（本期交付）

- [x] 桌面 Hub "手机"按钮 + 配对对话框 + 地址清单录入
- [x] `mobile-server` 模块（Express + ws + token 鉴权）
- [x] PWA 前端完整（列表页 + 会话页 + 输入条 + permission 卡片 + 折叠屏响应式）
- [x] PWA 加桌面图标（manifest + splash + 返回键拦截 + 键盘适配）
- [x] 多地址自动发现 + 断线重连
- [x] 设备管理（列表 + 撤销）
- [x] Tailscale 使用文档
- [x] 真机测试 + 端到端联调

### 9.2 二期不做（留坑）

- Web Push 推送（替代方案：现有 Hook 接企业微信机器人/Server 酱）
- Capacitor APK 打包（PWA 够用再说）
- iOS 深度兼容
- 手机端新建/关闭/重启 session
- 语音输入、拍照粘贴

---

## 10. 时间预估

| 阶段 | 工作量 |
|------|--------|
| 后端：mobile-server + 鉴权 + WS 协议 | 0.5 天 |
| 前端：PWA 主体（列表 + 详情 + 输入 + 卡片 + 响应式） | 1 天 |
| 配对 UI + 设备管理 + 多地址发现 | 0.5 天 |
| 真机联调 + 折叠屏实测 + Tailscale 文档 | 0.5 天 |
| **合计** | **2.5 天** |

---

## 11. 风险与未决

| 风险 | 应对 |
|------|------|
| 华为鸿蒙 ArkWeb 某些 PWA 特性支持不足（manifest 的 splash、Web Push 等） | MVP 不依赖 Web Push；splash 用 HTML 首屏代替；Mate X6 真机早测试 |
| Tailscale 在某些公司网络被封 | 配对清单可填其他公网方案（Cloudflare Tunnel / frp）；文档给三种选项 |
| Claude TUI 后续版本变更 permission prompt 格式，hook 检测失效 | permission 卡片降级为"检测失败但仍可手动输入 1/2"，不影响基本可用性 |
| PWA 被 WebView 回收导致 WS 丢失 | 前端检测到 visibilitychange 事件立即重连 |
| 手机 localStorage 被清 → token 丢失 | 只能重新配对；提示用户首次配对后不要手动清缓存 |

---

## 12. 决策摘要（设计过程中的关键抉择）

1. **方案：PWA vs 原生 App vs 远程桌面**
   → 选 PWA。开发/debug 循环秒级；80% 代码复用桌面 Electron；华为鸿蒙 ArkWeb 兼容完整；日后可用 Capacitor 一键打包。

2. **架构：独立进程 vs 共 Electron 进程**
   → 选共进程。复用 sessionManager，手机和桌面看到同一份 session 数据；关 Hub = 关移动端，心智一致。

3. **UI 布局：桌面等比缩小 vs 微信移动版式 vs 极简流**
   → 选微信移动版式。和桌面 Hub 心智一致；列表→详情→返回是肌肉记忆。

4. **输入方式：xterm 直连 vs 聊天式输入条**
   → 选聊天式输入条。避开 TUI 在手机软键盘 + IME 上的灾难；加 permission 专属卡片一键过。

5. **鉴权：纯内网裸奔 vs Token**
   → 选 Token。内网也有室友/访客风险；且公网场景必须要；`bcrypt hash` + 256 bit 随机 token。

6. **配对：每次扫码 vs 一次配对终身**
   → 选一次配对终身。首次人在电脑旁扫码 + 填公网地址清单，之后永久无感；丢了用撤销设备兜底。

7. **公网接入：MVP 先内网 vs MVP 就做完**
   → MVP 就做完。用户主要场景是公司远控家里电脑；Tailscale 方案集成到配对清单里，一次性配好。

8. **并发：多客户端互斥 vs 全部共享**
   → 全部共享。单用户场景物理上不会抢输入；tmux 多 client 同款语义。

---

## 附录 A：待用户 review 后进入 implementation plan

本设计文档经用户批准后，将由 `superpowers:writing-plans` skill 生成分步实施计划，然后进入 TDD 编码阶段。
