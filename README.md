# Portrait Studio

React 19 + Vite + Electron 的本地桌面提示词图库，版本 1.1.0。保留原有深色 UI、13 张素材和完整提示词（8 张摄影、5 张绘画）。离线运行，无账号或服务费用。

## 运行与开发

需要 Node.js 22.12+（本次使用 Node 25.6.0）、npm 和 macOS。

```bash
npm ci
npm start
```

`npm start` 先构建 React，然后启动 Electron。浏览器开发预览可用 `npm run dev`（仅监听 127.0.0.1）；其复制使用浏览器剪贴板，原图在新标签页打开。桌面原生功能以 `npm start` 为准。

悬停图卡可复制完整提示词，点击或 Enter/Space 打开详情；C 复制、⌘K 聚焦搜索、⌘Enter 复制详情、左右键切换、Esc 关闭。支持分类与名称/编号/文件名搜索、网格密度切换及主区滚动。

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

新产物位于 `release-react/`：

- `mac-arm64/Portrait Studio.app`
- `Portrait-Studio-React-1.1.0-arm64.dmg`
- `Portrait-Studio-React-1.1.0-arm64.zip`

DMG 提供应用与 Applications 拖拽入口，本项目不会自动安装。旧 `release/` 及运行中的旧实例保留。新应用原图作为外部资源打包，可由 macOS 系统打开。

验证打包后的应用：

```bash
PORTRAIT_STUDIO_EXECUTABLE="$PWD/release-react/mac-arm64/Portrait Studio.app/Contents/MacOS/Portrait Studio" node scripts/verify-electron.cjs
```

## 结构与安全

- `src/`：React 状态、侧栏、搜索、图库、详情和 toast 组件。
- `styles.css`：原有配色与布局；固定视口滚动容器让底部图卡可访问。
- `assets/`：原有图片和逐字保留的提示词数据。
- `main.js`：窗口、系统剪贴板与受限原图 IPC；`preload.js` 只暴露两个固定方法。
- `electron-security.cjs`：可信主 frame 验证、已知图片 allowlist 和真实路径检查。
- `vite.config.mjs`：React 构建到 `renderer-dist/`，使用本地相对资源。

生产开启 sandbox/contextIsolation/webSecurity，关闭 Node 集成，使用严格 CSP，禁止导航/新窗口/webview，拒绝权限请求。迁移前源码与素材在 `.verification/original/`，没有提交或推送。

## 签名与限制

当前没有可用 Developer ID 凭据，不配置正式签名或公证（`identity: null`，`notarize: false`）。`afterPack` 使用 macOS 自带 codesign 生成本地 ad-hoc 完整性签名，不能作为发行者身份认证。最终签名、Gatekeeper 和包验证结果见 `release-react/VERIFICATION.md`。本项目不移除 quarantine、不绕过 Gatekeeper，也不更改系统安全设置。

用户指定的 Library 参考图在两次授权下载后仍不可用；对照使用本 Mac 实际运行的原版截图，不声称完成该外部参考图的像素对照。

已有依赖的 npm audit 告警单独记录于验证报告；没有使用未经验证的主版本覆盖来消除告警。
