# Claude Session Hub - 分享与分发方案设计

**日期**: 2026-04-16
**状态**: Draft
**目标**: 让同事能快速安装使用 Claude Session Hub，提供两条路径：技术安装 + 懒人安装包

---

## 背景

Claude Session Hub 是一个 Electron 多会话终端管理器，目前仅作者本人在用。同事们已有 Claude Code CLI 订阅环境，都使用 Clash 代理（127.0.0.1:7890）。项目已在 GitHub public repo（TianLin0509/claude-session-hub），需要完善文档和安装流程让他人可用。

## 当前问题

1. **硬编码个人路径**: `create-shortcut.ps1` 中 4 处 `C:\Users\lintian\claude-session-hub`
2. **缺少安装自动化**: hook 脚本 (`session-hub-hook.py`, `claude-hub-statusline.js`) 需手动复制到 `~/.claude/scripts/`，settings.json 需手动编辑注册 hooks
3. **缺少 README**: 新用户 clone 后不知道怎么用
4. **缺少打包**: 非技术用户需要 Node.js + C++ Build Tools 才能 `npm install`
5. **缺少 LICENSE**: 开源项目应声明许可证

## 分发架构

```
GitHub Repo (public)
├── 路径 A: 技术同事
│   clone → install.ps1 → 桌面快捷方式
│   前提: Node.js 18+, C++ Build Tools (npm 编译 node-pty)
│
└── 路径 B: 懒人包
    GitHub Releases → 下载 .exe → 双击安装
    前提: 无（node-pty prebuilt 打包在内）
```

## 改造项

### 1. 去个人耦合

#### 1.1 `create-shortcut.ps1`

4 处硬编码路径改为动态获取：

```powershell
# Before:
$icoPath = "C:\Users\lintian\claude-session-hub\claude-wx.ico"
$s.TargetPath = "C:\Users\lintian\claude-session-hub\node_modules\electron\dist\electron.exe"
$s.Arguments = '"C:\Users\lintian\claude-session-hub"'
$s.WorkingDirectory = "C:\Users\lintian\claude-session-hub"

# After:
$projectRoot = Split-Path -Parent $PSScriptRoot  # 如果脚本在根目录则用 $PSScriptRoot
$icoPath = Join-Path $projectRoot "claude-wx.ico"
$s.TargetPath = Join-Path $projectRoot "node_modules\electron\dist\electron.exe"
$s.Arguments = "`"$projectRoot`""
$s.WorkingDirectory = $projectRoot
```

注意：脚本在项目根目录，所以直接用 `$PSScriptRoot`。

#### 1.2 `docs/tech-architecture.html`

`C:\Users\lintian\claude-session-hub` → 用占位文本 `<your-install-path>` 或直接删除绝对路径。

#### 1.3 `PROJECT.html`

`C:\\Users\\lintian` → `C:\\Users\\<username>` 或类似通用表达。

#### 1.4 `session-manager.js` 代理配置

代理地址提取为模块顶部常量，保留默认值 `127.0.0.1:7890`，并加注释说明如何修改：

```javascript
// Default proxy for Claude sessions. All colleagues use Clash on this address.
// Change here if your proxy is different.
const CLAUDE_PROXY = 'http://127.0.0.1:7890';
```

### 2. Hook 脚本打包到 repo

当前 hook 脚本存放在 `~/.claude/scripts/` 目录，不在 repo 内。需要：

- 在 repo 根目录新建 `scripts/` 文件夹
- 将 `session-hub-hook.py` 和 `claude-hub-statusline.js` 的**模板版本**放入 `scripts/`
- 安装时从这里复制到用户的 `~/.claude/scripts/`

文件清单：
```
scripts/
  session-hub-hook.py        — CC Stop/UserPromptSubmit hook
  claude-hub-statusline.js   — CC statusline script
```

### 3. 一键安装脚本 `install.ps1`

放在项目根目录。流程：

```
Step 1: 检查 Node.js >= 18
        失败 → 打印下载链接，退出

Step 2: npm install
        失败 → 提示安装 C++ Build Tools (npm install -g windows-build-tools 或 VS Build Tools)

Step 3: 部署 hook 脚本
        复制 scripts/session-hub-hook.py → ~/.claude/scripts/session-hub-hook.py
        复制 scripts/claude-hub-statusline.js → ~/.claude/scripts/claude-hub-statusline.js

Step 4: 注入 settings.json hook 配置
        读取 ~/.claude/settings.json
        如果 hooks 里没有 Stop/UserPromptSubmit 的 session-hub 条目，merge 进去
        如果已有，跳过（不覆盖）
        写回文件（保持原有配置不变）

Step 5: 创建桌面快捷方式
        调用 create-shortcut.ps1

Step 6: 打印完成信息
        "安装完成！双击桌面 Claude Hub 图标启动。"
        "首次使用请在 Hub 内执行 /login 登录 Claude 账号。"
```

需要注入的 settings.json hook 配置：
```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python ~/.claude/scripts/session-hub-hook.py stop"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "python ~/.claude/scripts/session-hub-hook.py user-prompt-submit"
          }
        ]
      }
    ]
  }
}
```

同时注入 statusline 配置到 `projects` 或顶层 settings。具体字段参考当前用户的 settings.json 结构。

### 4. README.md

结构：

```markdown
# Claude Session Hub

> 微信风格的 Claude Code 多会话终端管理器

[截图/GIF]

## Features
- 多会话标签页管理（类微信聊天列表）
- 会话持久化与休眠恢复（Dormant Restore）
- 未读消息计数
- Context/Usage 实时监控
- 终端内搜索、URL 点击、文件拖拽
- 手机远程 PWA 控制
- 快捷键全覆盖

## 前置条件
- Windows 10/11
- Claude Code CLI 已安装并登录（`claude /login`）
- Clash 代理运行在 127.0.0.1:7890

## 快速开始

### 方式 A：从源码安装（推荐技术用户）
git clone https://github.com/TianLin0509/claude-session-hub.git
cd claude-session-hub
.\install.ps1

### 方式 B：下载安装包
前往 [Releases](https://github.com/TianLin0509/claude-session-hub/releases) 下载最新 .exe，双击安装。

## 快捷键
[表格]

## FAQ
- Q: 启动后没有会话？  A: Hub 默认不自动创建会话，按 Ctrl+N 新建
- Q: Hook 没生效？  A: 检查 ~/.claude/settings.json 里的 hooks 配置
- Q: node-pty 编译失败？  A: 安装 VS Build Tools...
```

### 5. Electron 打包

#### 5.1 工具选择

使用 `electron-builder`，配置 NSIS 安装包（Windows .exe）。

#### 5.2 `electron-builder` 配置（package.json 追加）

```json
{
  "build": {
    "appId": "com.claude-session-hub",
    "productName": "Claude Session Hub",
    "win": {
      "target": "nsis",
      "icon": "claude-wx.ico"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "installerIcon": "claude-wx.ico",
      "uninstallerIcon": "claude-wx.ico",
      "createDesktopShortcut": true
    },
    "files": [
      "main.js",
      "core/**/*",
      "renderer/**/*",
      "renderer-mobile/**/*",
      "scripts/**/*",
      "claude-wx.ico",
      "package.json",
      "node_modules/**/*"
    ],
    "extraResources": [
      {
        "from": "scripts",
        "to": "scripts"
      }
    ],
  },
  "scripts": {
    "dist": "electron-builder --win"
  }
}
```

#### 5.3 首次启动 Hook 自动部署

无论源码安装还是 exe 安装，`main.js` 的 `app.whenReady()` 中统一执行 hook 部署检测：

```javascript
function ensureHooksDeployed() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const scriptsDir = path.join(claudeDir, 'scripts');

  // 1. 复制 hook 脚本到 ~/.claude/scripts/（不存在时）
  //    源码模式: 从项目 scripts/ 目录读
  //    打包模式: 从 process.resourcesPath + '/scripts/' 读
  const srcDir = app.isPackaged
    ? path.join(process.resourcesPath, 'scripts')
    : path.join(__dirname, 'scripts');

  for (const file of ['session-hub-hook.py', 'claude-hub-statusline.js']) {
    const dest = path.join(scriptsDir, file);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.copyFileSync(path.join(srcDir, file), dest);
    }
  }

  // 2. Merge hook 配置到 ~/.claude/settings.json（不覆盖已有条目）
  //    检查 hooks.Stop 和 hooks.UserPromptSubmit 是否已包含 session-hub-hook
  //    statusLine 配置同理
}
```

`install.ps1`（源码路径）也执行相同逻辑，两条路径结果一致。

#### 5.4 构建流程（手动，后续可加 CI）

```powershell
npm install
npm run dist
# 产物在 dist/ 目录，上传到 GitHub Releases
```

### 6. LICENSE

MIT License，标准模板，copyright 写项目名不写个人名：

```
MIT License
Copyright (c) 2026 Claude Session Hub Contributors
```

### 7. .gitignore 补充

确保以下不进 repo：
```
dist/
*.exe
```

## 不做的事情

- **不改代理默认值** — 同事们都用 Clash 7890，保持硬编码，只提取为常量方便未来修改
- **不做 CI/CD** — 先手动 build + 上传 Release，用户量大了再加 GitHub Actions
- **不做 auto-update** — 第一版不加自动更新，同事手动更新即可
- **不做 Mac/Linux 支持** — 当前项目仅 Windows（node-pty spawn powershell.exe），同事也都是 Windows

## 安全与隐私

- repo 中不含任何 API key、token、credential
- hook token 是每次启动随机生成的，不持久化
- settings.json 里的 hook 配置只指向本地脚本路径
- 用户各自登录自己的 Claude 账号（`/login`）
- `.claude-session-hub/state.json` 等运行态文件在用户 home 目录，不进 repo

## 文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| 修改 | `create-shortcut.ps1` | 硬编码路径 → 动态 `$PSScriptRoot` |
| 修改 | `session-manager.js` | 代理地址提取为常量 |
| 修改 | `docs/tech-architecture.html` | 清理个人路径 |
| 修改 | `PROJECT.html` | 清理个人路径 |
| 修改 | `package.json` | 添加 electron-builder 配置 + dist 脚本 |
| 修改 | `main.js` | 添加 `ensureHooksDeployed()` 首次启动检测 |
| 修改 | `.gitignore` | 添加 dist/ 和 *.exe |
| 新建 | `scripts/session-hub-hook.py` | hook 脚本（从 ~/.claude/scripts/ 复制模板） |
| 新建 | `scripts/claude-hub-statusline.js` | statusline 脚本（同上） |
| 新建 | `install.ps1` | 一键安装脚本 |
| 新建 | `README.md` | 项目文档 |
| 新建 | `LICENSE` | MIT License |
