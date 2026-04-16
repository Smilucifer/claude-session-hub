# Claude Session Hub 会话工作路径与重命名 —— 设计文档

**日期**: 2026-04-17
**作者**: 巧克力 × Claude (brainstorming skill)
**状态**: Draft (awaiting user review)
**目标仓库**: `D:\ClaudeWorkspace\Code\claude-session-hub`

---

## 1. 背景与目标

### 1.1 问题陈述

当前 Claude Session Hub 在新建 session 时默认把工作目录落到用户目录（通常是 `C:\Users\<username>`），顶部展示的 cwd 只是显示，不支持直接修改。与此同时，session 的重命名主要依赖命令方式，缺少直观的图形交互入口。

这导致两个体验问题：
1. 用户每次创建新 session 后还要手动切换到常用工作目录，重复操作多。
2. 用户想管理多个 session 时，名称只能靠默认规则或命令修改，不够直观。

### 1.2 目标（本次改动）

本次改动聚焦两个能力：
1. 让 session 顶部显示的 cwd 变成**可编辑工作路径**。
2. 让 session 支持**图形化重命名**，包括右键菜单入口和双击内联编辑入口。
3. 把“默认工作路径”改成**项目内外置 JSON 配置**，方便用户直接修改。

### 1.3 非目标（本次不做）

- 不新增复杂设置页；默认工作路径仅通过 JSON 配置文件控制。
- 不在 Claude 正在交互过程中强行注入 `cd` 改变其当前 CLI 输入状态。
- 不改动 transcript、hook server、mobile server 的总体架构。
- 不引入数据库或新的持久化层。

---

## 2. 用户体验

### 2.1 默认工作路径

项目新增一个外置配置文件：

`config/session-hub.json`

建议最小内容如下：

```json
{
  "defaultWorkingDirectory": "D:\\ClaudeWorkspace"
}
```

行为如下：
- 新建 session 时，优先读取这个配置中的 `defaultWorkingDirectory`。
- 若配置文件不存在、字段为空、目录不存在，则回退到现有逻辑（用户目录）。
- 用户可以直接修改 JSON 文件，无需重新编译。

### 2.2 顶部工作路径可编辑

当前会话顶部显示的 cwd 改为可点击编辑：
- 点击路径后切换成输入框。
- `Enter`：提交修改。
- `Esc`：取消修改。
- 失焦：按“提交”处理，但只有校验通过才生效。

校验规则：
- 路径不能为空。
- 路径必须存在。
- 非法路径时显示错误提示，并保持原值不变。

不同 session 类型行为：
- **PowerShell session**：提交成功后立即执行 `Set-Location -LiteralPath '<path>'`，真实切换终端 cwd。
- **Claude session**：不向正在运行的 Claude CLI 强塞 `cd`。仅更新该 session 的目标工作路径，用于后续新建、恢复、重启等流程。

### 2.3 Session 重命名

重命名支持两种图形入口：
1. **右键菜单新增 `Rename session`**
2. **双击左侧 session 标题后内联编辑**

同时保留现有 `/rename` 命令作为兼容入口。

编辑行为：
- `Enter` 保存
- `Esc` 取消
- 失焦提交
- 空白名称不允许
- 自动去掉首尾空格
- 名称过长时截断（建议 80 字符以内）

---

## 3. 架构与职责划分

### 3.1 配置层

新增轻量配置读取模块，例如：

`core/app-config.js`

职责：
- 读取 `config/session-hub.json`
- 返回标准化配置对象
- 校验 `defaultWorkingDirectory` 是否存在
- 配置异常时提供安全回退值

建议暴露接口：
- `loadAppConfig()`
- `getDefaultWorkingDirectory()`

### 3.2 主进程

`main.js` 负责：
- 启动时加载配置模块
- 在 `create-session` 流程里传递默认 cwd
- 新增 IPC：`set-session-cwd`
- 继续复用现有 `rename-session`

新 IPC 语义：
- `ipcMain.handle('set-session-cwd', (_e, { sessionId, cwd }))`
- 校验路径存在
- 调用 `sessionManager.changeSessionCwd(sessionId, cwd)`
- 成功后返回更新后的 session 公共对象

### 3.3 SessionManager

`core/session-manager.js` 新增会话级 cwd 修改能力。

建议新增方法：
- `changeSessionCwd(sessionId, cwd)`

职责：
- 更新 `session.info.cwd`
- 对 PowerShell session 立即写入 `Set-Location -LiteralPath ...`
- 对 Claude session 只更新元数据，不直接写 PTY
- 触发 `session-updated`

同时 `createSession()` 的 cwd 选择顺序改为：
1. 调用方显式传入的 `opts.cwd`
2. 当前 session 已记录的 cwd（恢复/重启场景）
3. `config/session-hub.json` 中的 `defaultWorkingDirectory`
4. 用户目录

### 3.4 渲染层

`renderer/renderer.js` 负责 UI 交互：
- 顶部 cwd 区域可点击编辑
- 左侧 session 标题支持双击内联编辑
- 右键菜单增加 `Rename session`
- 三个入口最终复用同一套提交逻辑

建议抽出两个共用函数：
- `beginRenameSession(sessionId)`
- `beginEditSessionCwd(sessionId)`

这能避免菜单重命名、双击重命名、命令重命名三套逻辑分叉。

---

## 4. 数据流

### 4.1 新建 session 的默认路径流

```text
用户点击新建 session
  → renderer invoke('create-session', ...)
  → main.js 组装 opts.cwd
  → 若未显式指定 cwd，则读取 app-config
  → sessionManager.createSession(kind, { cwd })
  → PTY 以该 cwd 启动
```

### 4.2 编辑顶部工作路径流

```text
用户点击顶部 cwd
  → renderer 进入输入模式
  → 用户提交新路径
  → ipcRenderer.invoke('set-session-cwd', { sessionId, cwd })
  → main.js 校验路径
  → sessionManager.changeSessionCwd(sessionId, cwd)
  → 成功后 session-updated
  → renderer 刷新顶部路径与左侧 session 元数据
```

### 4.3 图形化重命名流

```text
用户右键菜单点 Rename session
或双击左侧标题
  → renderer 进入重命名输入模式
  → 用户提交标题
  → ipcRenderer.invoke('rename-session', { sessionId, title })
  → sessionManager.renameSession(sessionId, title)
  → session-updated
  → renderer 刷新左侧列表和当前标题
```

---

## 5. 交互细节

### 5.1 顶部 cwd 编辑

推荐行为：
- 输入框默认填当前 cwd
- 提交时如果路径不存在，显示轻量错误提示（toast 或 inline error）
- PowerShell 会话切换成功后，顶部立即显示新 cwd
- Claude 会话切换成功后，顶部也显示新 cwd，但附带语义说明：该路径会用于后续恢复/重启/新建继承，而不是强行改变正在运行中的 Claude CLI 进程状态

### 5.2 右键菜单

当前菜单项：
- Pin to top
- Restart session
- Close

新增后建议顺序：
- Pin to top
- Rename session
- Restart session
- Close

原因：
- Rename 属于高频轻操作，应比 Restart 更靠前。
- Close 继续放在最下方，避免误触。

### 5.3 双击标题重命名

- 双击 session 标题区域进入编辑态
- 编辑态只替换标题文本区域，不影响时间戳/状态显示区域
- 若当前已有一个 session 正在编辑，新的编辑动作应先收起旧编辑态，避免多个输入框同时存在

---

## 6. 错误处理

### 6.1 配置文件错误

- 配置文件不存在：静默回退到用户目录
- JSON 解析失败：记录日志，静默回退到用户目录
- `defaultWorkingDirectory` 指向不存在路径：记录日志，静默回退到用户目录

### 6.2 cwd 修改失败

- session 不存在：返回错误
- 路径不存在：返回错误
- PowerShell 写入 `Set-Location` 后若终端实际失败，先以主进程可校验路径为准；不做复杂命令回显解析

### 6.3 重命名失败

- session 不存在：返回错误
- 空白标题：拒绝提交
- 与原名称相同：视为无操作

---

## 7. 测试策略

### 7.1 配置读取

- 配置文件存在且路径有效 → 新 session 使用配置路径
- 配置文件不存在 → 回退用户目录
- 配置文件 JSON 非法 → 回退用户目录
- 配置路径不存在 → 回退用户目录

### 7.2 PowerShell session cwd 编辑

- 修改为有效目录 → 顶部与 session 元数据更新
- 修改为无效目录 → 显示错误，原值保留

### 7.3 Claude session cwd 编辑

- 修改后 session 元数据更新
- 重启该 session 时新 cwd 生效
- 不向当前交互流注入 `cd`

### 7.4 图形化重命名

- 右键菜单重命名成功
- 双击内联重命名成功
- `/rename` 命令仍兼容
- 重命名后列表和活动标题同步更新

---

## 8. 取舍与理由

### 8.1 为什么默认路径用项目内 JSON

因为你的目标是“方便用户直接修改”，而不是做一层沉重设置系统。项目内 JSON：
- 简单
- 透明
- 易于手改
- 适合当前项目规模

### 8.2 为什么 Claude session 不强制即时 cd

因为 Claude CLI 正在交互时，强塞 `cd` 到 PTY 输入流会污染用户当前输入和 TUI 状态。这个风险高于收益。

因此本设计选择稳妥方案：
- PowerShell session：立即真实切目录
- Claude session：更新目标 cwd，延迟到恢复/重启/新建继承时生效

### 8.3 为什么重命名支持两种图形入口

因为：
- 右键菜单符合显式操作习惯
- 双击标题符合高频快捷操作习惯
- 两者共存最符合桌面应用体验

---

## 9. 实施范围总结

本次改动涉及：
- `config/session-hub.json`（新增）
- `core/app-config.js`（新增）
- `core/session-manager.js`
- `main.js`
- `renderer/renderer.js`

本次改动不涉及：
- Claude hook 协议
- transcript 格式
- mobile server 协议
- 打包流程

---

## 10. 待用户确认的最终结论

本设计确认以下行为：
1. 默认工作路径从项目内 JSON 读取。
2. 顶部 cwd 可编辑。
3. PowerShell session 立即切目录。
4. Claude session 不强制即时切目录，只更新目标路径。
5. session 重命名支持右键菜单和双击标题两种图形入口。
6. `/rename` 命令继续保留。
