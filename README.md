# Portrait Studio

React 19 + Vite + Electron 的本地桌面提示词图库，版本 1.2.0。保留原有深色 UI、13 张素材和完整英文提示词（8 张摄影、5 张绘画），新增逐段完整中文翻译。离线运行，无账号或服务费用。

## 运行与开发

需要 Node.js 22.12+（本次使用 Node 25.6.0）、npm 和 macOS。

```bash
npm ci
npm start
```

`npm start` 先构建 React，然后启动 Electron。浏览器开发预览可用 `npm run dev`（仅监听 127.0.0.1）；其复制使用浏览器剪贴板，原图在新标签页打开。桌面原生功能以 `npm start` 为准。

悬停图卡可复制完整提示词，点击或 Enter/Space 打开详情；C 复制、⌘K 聚焦搜索、⌘Enter 复制详情、左右键切换、Esc 关闭。支持分类与名称/编号/文件名搜索、网格密度切换及主区滚动。

图库工具栏和详情的 English／中文按钮选择提示词语言，所有复制入口使用当前语言，关闭详情、筛选或切换图片不会改变语言。选择通过本地 localStorage 保存；首次使用默认英文。原英文在 `assets/selected-prompts.json` 中逐字保留，中文在独立的 `assets/prompts.zh.json` 中按原 ID 存放，包含全部重复限制及 053 的粉彩修订。界面标签和搜索规则保持原样。Drive 接入已暂停，没有接入文件、OAuth 凭据或默认行为变化。

## 验证

```bash
npm run check
npm test
npm run test:electron
```

Electron 验证会启动独立 profile，只关闭测试实例；实际验证原生剪贴板和打开原图，生成 `.verification/` 截图与 JSON 证据。测试会恢复文字、HTML、RTF、图片剪贴板内容。

## Mac 打包

```bash
npm run package  # Apple Silicon .app
npm run dist:mac # Apple Silicon DMG + ZIP
```

打包使用已安装的同版本 Electron，避免重复下载；镜像通过 macOS 自带 ditto/hdiutil 创建，原图与 React 资源一并打包，未使用的 Node 依赖不进入应用。

1.2.0 新产物位于 `release-bilingual/`，原 `release-react/` 的 1.1.0 包保留：

- `mac-arm64/Portrait Studio.app`
- `Portrait-Studio-React-1.2.0-arm64.dmg`
- `Portrait-Studio-React-1.2.0-arm64.zip`

DMG 提供应用与 Applications 拖拽入口，本项目不会自动安装。旧 `release/` 及运行中的旧实例保留。新应用原图作为外部资源打包，可由 macOS 系统打开。

验证打包后的应用：

```bash
PORTRAIT_STUDIO_EXECUTABLE="$PWD/release-bilingual/mac-arm64/Portrait Studio.app/Contents/MacOS/Portrait Studio" PORTRAIT_STUDIO_VERIFICATION_NAME=bilingual-packaged node scripts/verify-electron.cjs
```

## 结构与安全

- `src/`：React 状态、侧栏、搜索、图库、详情和 toast 组件。
- `styles.css`：原有配色与布局；固定视口滚动容器让底部图卡可访问。
- `assets/`：原有图片、逐字保留的英文及独立中文提示词数据。
- `main.js`：窗口、系统剪贴板与受限原图 IPC；`preload.js` 只暴露两个固定方法。
- `electron-security.cjs`：可信主 frame 验证、已知图片 allowlist 和真实路径检查。
- `vite.config.mjs`：React 构建到 `renderer-dist/`，使用本地相对资源。

生产开启 sandbox/contextIsolation/webSecurity，关闭 Node 集成，使用严格 CSP，禁止导航/新窗口/webview，拒绝权限请求。迁移前源码与素材在 `.verification/original/`。本次没有提交或推送。

## Git LFS 与按需下载

仅 `/assets/images/*.png` 使用 Git LFS；React 源码、提示词 JSON、文档和 lockfile 仍为普通 Git 文本。构建与 DMG/ZIP 输出目录继续忽略，不提交到 LFS。安装 `git-lfs` 后，在仓库内仅配置当前仓库：

```bash
git lfs install --local
```

本次新增 `.gitattributes` 和仓库本地 filter/hooks 配置，不修改全局 Git 配置，不暂存、提交、推送或改写历史。13 张当前图片原字节仍在工作区。其已有 Git 提交仍保存普通 PNG blob；准备下一次提交时可执行 `git add --renormalize -- assets/images` 将它们暂存为 LFS 指针，再审查 `git lfs ls-files` 和暂存差异。此命令未对正常索引执行。指针转换已在独立临时索引验证，13 个指针的 SHA-256 和长度与原图一致。

Git LFS 不压缩 PNG，也不自动缩减旧 Git 历史。当前 HEAD 图片共 33,577,848 字节（32.02 MiB），原历史仍含这些数据。全部本地 refs 的 blob 共 34,113,562 字节（32.53 MiB）；审计前 `.git` 实占约 36.12 MiB。历史迁移会改变提交 SHA，需要协调已共享分支和强制推送；本次未执行，也不建议为约32 MiB资产默认改写。

默认 clone/checkout 可能自动下载当前版本的全部 LFS 素材；按需下载示例（这些指令适用于图片转换、提交并上传 LFS 后的新版本）：

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/GHjiejie/photo_generate_desktop.git
cd photo_generate_desktop
git lfs install --local
git lfs pull --include="assets/images/001-natural-window.png" --exclude=""
# 完整运行/打包需要全部 13 张原图
git lfs pull --include="assets/images/*.png" --exclude=""
```

skip-smudge 只能跳过 LFS 对象，不能跳过旧提交中的普通 Git PNG blob；未下载的指针不能当图片运行。源码 ZIP 已包含真实原图，解压使用不需要从 LFS 下载。[官方 LFS 说明](https://git-lfs.com/)、[仓库本地配置](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-install.adoc)、[选择性 pull](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-pull.adoc)。

## 签名与限制

当前没有可用 Developer ID 凭据，不配置正式签名或公证（`identity: null`，`notarize: false`）。`afterPack` 使用 macOS 自带 codesign 生成本地 ad-hoc 完整性签名，不能作为发行者身份认证。最终签名、Gatekeeper 和包验证结果见 `release-bilingual/VERIFICATION.md`。本项目不移除 quarantine、不绕过 Gatekeeper，也不更改系统安全设置。

用户指定的 Library 参考图在两次授权下载后仍不可用；对照使用本 Mac 实际运行的原版截图，不声称完成该外部参考图的像素对照。

已有依赖的 npm audit 告警单独记录于验证报告；没有使用未经验证的主版本覆盖来消除告警。
