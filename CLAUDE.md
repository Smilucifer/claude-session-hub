# Claude Session Hub 项目规范

## 铁律：Hub 依赖完整性（node_modules 不容许半坏）

**Hub 反复出现"桌面图标点开报错无法打开"，几乎每次根因都是 `node_modules` 缺了传递依赖（典型：`Cannot find module 'dijkstrajs'` — `qrcode` 的依赖）。`main.js` 顶部 `require('qrcode')` 一挂，整个 Electron 启动链终止。防止这种事反复发生，规则如下：**

**触发场景**（以下任一都算"node_modules 风险操作"）：
- `npm install` / `npm ci` / `npm prune` / `npm run dist`（electron-builder 会对源 `node_modules` 做 rebuild + prune）
- `git checkout` 切到 `package.json` 或 `package-lock.json` 不同的分支
- `git pull` 拉进了修改 lock 文件的 commit
- 任何手工删除/移动 `node_modules/` 子目录
- 被 Windows EBUSY 打断的 npm 操作（`debug.log` / native 模块被 electron.exe 锁住）

**硬性规则**：

1. **`npm run dist` 禁止在主工作目录跑**。必须在独立 worktree（如 `git worktree add ../hub-dist master` 新开目录）里打包，避免 electron-builder 的 rebuild/prune 污染源 `node_modules`。主工作目录只用于开发和启动 Hub。

2. **任何 node_modules 风险操作后，必须 smoke test 启动**：
   ```bash
   timeout 6 ./node_modules/electron/dist/electron.exe . 2>&1 | head -20
   ```
   看到 `[hub] hook server listening on 127.0.0.1:...` 才算通过。看到 `App threw an error during load: Cannot find module 'XXX'` 就是依赖缺失，立即 `npm install` 重对齐。**smoke test 未通过之前，绝不告诉用户"已修复/已完成"。**

3. **Hub 启动报 "Cannot find module"，第一反应执行 `npm install`**（按 `package-lock.json` 补齐），不要去怀疑代码或改 main.js。只有 `npm install` 后仍报同名模块错误，才深入查。

4. **`dist/*.exe` NSIS 安装器绝不能双击启动测试**。它是独立安装流程，装到别的目录，与源开发环境脱节。测试只走桌面快捷方式 `claudeWX.lnk`（指向 `node_modules/electron/dist/electron.exe` + 源工作目录）或 `start.bat`。

5. **Windows EBUSY 处理**：`npm install` 报 `EBUSY rename node_modules/electron/dist/debug.log` → 一定有 electron.exe 进程锁着该文件。先 `Get-Process electron | Where-Object { $_.StartTime -gt (Get-Date).AddMinutes(-N) }` 筛出近期自己启动的进程（禁止动用户生产 Hub），`Stop-Process` 后再重试 install。

6. **多 worktree 并存时**：每个 worktree 有独立 `node_modules`，严禁 symlink 或共享。在 worktree A 里的 npm 操作不应影响 worktree B。

**血泪案例**：2026-04-19 用户桌面图标启动 Hub 报 `Cannot find module 'dijkstrajs'`，node_modules 被大规模清空（`npm install` 补回 182 个包）。推断起因是 04-16 `npm run dist` 在主工作目录跑 + 分支反复切换期间 npm 操作被 EBUSY 打断，留下长期半坏状态。用户明确表示已反复遇到同一问题。
