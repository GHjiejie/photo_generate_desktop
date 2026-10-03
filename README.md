# Portrait Studio

React 19 + Vite + Electron 的本地桌面提示词图库，版本 1.4.0。保留原有深色 UI、13 张内置素材（8 张摄影、5 张绘画）、完整 English／中文提示词和本地素材增删改，新增基于本地版本文档及本地发布目录的更新流程。无需发布服务、账号或付费服务；Drive 接入继续暂停。

## 运行与开发

需要 Node.js 22.12+（本次使用 Node 25.6.0）、npm 和 macOS。

```bash
npm ci
npm start
```

`npm start` 先构建 React，然后启动 Electron。在没有已保存目录配置或环境覆盖时，开发版默认使用当前项目根目录作为可编辑素材库，会建立本地索引；新增、编辑和删除会真实修改这个目录中的素材。浏览器开发预览可用 `npm run dev`（仅监听 127.0.0.1）；网页预览显示内置精选，复制使用浏览器剪贴板，原图在新标签页打开，素材增删改需使用 Mac 桌面应用。

悬停图卡可复制完整提示词，点击或 Enter/Space 打开详情；C 复制、⌘K 聚焦搜索、⌘Enter 复制详情、左右键切换、Esc 关闭。支持分类与名称/编号/文件名搜索、网格密度切换及主区滚动。

图库工具栏和详情的 English／中文按钮选择提示词语言，所有复制入口使用当前语言，关闭详情、筛选或切换图片不会改变语言。选择通过本地 localStorage 保存；首次使用默认英文。内置英文在 `assets/selected-prompts.json` 中逐字保留，中文在独立的 `assets/prompts.zh.json` 中按原 ID 存放，包含全部重复限制及 053 的粉彩修订。界面标签、原有布局和名称／编号／文件名搜索规则保持原样。

## 本地素材管理

打包版首次运行显示只读的内置精选。点击侧栏“选择保存文件夹”，通过 macOS 原生目录选择器选定本机用于长期保存图片和中英提示词的可写文件夹后才能导入、编辑或删除。当前真实路径显示在侧栏，可悬停查看完整路径；选择后记在应用 profile，后续启动继续使用。“切换素材库”仅更换当前管理的文件夹，通过刷新按钮重新读取。使用原项目素材时选择项目文件夹，不需要每次重选；这里没有云端上传。

选择空目录会建立空素材库，不会自动复制内置 13 张素材。如果所选目录已有原项目的 `assets/images/`、`assets/selected-prompts.json` 和 `assets/prompts.zh.json`，首次打开会读取这些资料并建立新索引；已有索引则以索引为准。后续 CRUD 写入新索引，不会自动回写这两份旧格式提示词 JSON，也不将删除或修改自动同步到 Git。

- “导入图片与提示词”：通过 macOS 原生文件选择器选择本机 PNG、JPEG 或 WebP（最大 30 MiB），填写编号、名称、质感以及完整英文和中文提示词。导入保存副本，所选源文件保留。
- 详情中的“编辑肖像”：修改名称、质感和两种完整提示词，也可更换图片；已有编号保持不变。更换后旧图片移到 macOS 废纸篓。
- 详情中的删除操作：确认后将当前图片移到 macOS 废纸篓，并从当前素材索引移除；取消确认不改变素材。
- 保存发生版本冲突时保留当前输入，需核对最新记录后再继续；权限、图片校验或文件操作失败会显示错误。

选定目录中的文件结构：

```text
assets/images/                         原有图片与导入副本
.portrait-studio/library.json          当前索引，含完整 EN/ZH 提示词与图片校验信息
.portrait-studio/recovery/<事务ID>/     修改/删除前的图片副本及 record.json
.portrait-studio/transactions/         未完成操作的事务记录
```

每次编辑、替换或删除都会保留旧图片副本，以及包含完整旧英文／中文提示词的恢复记录。事务记录用于文件操作失败或重新打开后的恢复检查，遇到外部改动冲突时保留记录。当前没有 UI 撤销／恢复按钮；不要把废纸篓找回图片等同于自动恢复索引和提示词。

## 本地版本检查与更新

点击左下角“检查更新 / 升级最新版”，在更新窗口选择含 `updates.json` 和更新 ZIP 的本地发布目录。来源保存在应用 profile。检查使用语义化版本比较，仅提供高于当前版本的候选；相同版本、旧版本不会提供升级。当前只支持本地 ZIP，未实现 HTTPS 下载、在线发布、GitHub Releases 或 PAT 接入。

“准备并校验更新”读取本地包，检查 manifest 的 SHA-256（填写 `size` 时同时核对实际字节数），解包后核对 bundle ID、目标版本、arm64 架构、codesign 完整性及 macOS Gatekeeper 结果。来源目录、manifest 和 ZIP 不能通过符号链接或路径越界逃离所选目录。准备不会自动安装；只有 `verified` 与 `canInstall` 均满足时才提供重启安装，并要求用户再次确认。更新 ZIP 最大 1 GiB，展开数据最大 2 GiB。源码运行支持版本检查；准备和替换需要已打包应用及可写的应用父目录，不能从只读 DMG 内替换应用。

确认后由独立 helper 等待原应用退出，保留旧应用备份并替换应用，通过 macOS 正常 `open` 重启。新版本需在 renderer 就绪后确认此次启动，才记录安装完成。取消确认不会退出或替换应用；安装失败或没有收到就绪确认时，先检查目标及备份状态，再尝试回滚。遇到外部改动冲突时停止覆盖并保留备份和状态记录。素材目录和用户设置独立于应用包。

旧包与新包的两次 rename 分别是原子的，整体依靠状态日志和受保护恢复。helper 被强制终止或断电后不会自动唤醒或扫描恢复；应用旁 `.portrait-update-<UUID>/` 保留 `plan.json`、`state.json`、日志及 `previous.app`。需对该既有计划显式运行 helper 的 `--recover-plan`，它会重新校验目标和备份身份，不能直接覆盖有外部改动的应用。不能核实未确认新进程的身份时，会记录 `rollback-blocked` 并保留备份，不启动第二个实例或强制覆盖。

SHA-256 来自同一个本地来源，只能校验完整性，不能独立认证发布者身份。更新流程的编写和版本检查不以发布服务或正式签名为前提，但实际安装尊重系统检查：当前 ad-hoc 包的 `spctl` 结果为 rejected，准备可以完成完整性检查，`canInstall` 仍为 false，不能自动安装该包。本项目不移除 quarantine、不绕过 Gatekeeper、不更改系统设置。

发布目录示例：

```text
release-update/
  updates.json
  Portrait-Studio-React-1.4.0-arm64.zip
  Portrait-Studio-React-1.4.0-arm64.dmg
```

`npm run dist:mac` 自动执行 `scripts/write-update-manifest.cjs`，将生成的 ZIP 的真实 SHA-256、字节大小、package.json 版本、bundle ID 及目标平台写入 `release-update/updates.json`。已有 ZIP 时也可单独运行：

```bash
node scripts/write-update-manifest.cjs
```

`updates.example.json` 仅是格式示例：其中 1.4.1、包名和全零 SHA-256 都是占位内容，必须替换为真实匹配的版本、ZIP、校验值（若填写 size，也须是实际字节数），再命名为 `updates.json`。自动生成的 1.4.0 manifest 可供实现此协议的较旧版本检查；现有 1.3.0 没有更新入口，需手动使用新安装包。1.4.0 应用检查同版本文档会显示没有更高版本。

## 验证

```bash
npm run check
npm test
npm run test:electron
npm run test:updates
```

1.3.0 的 29 项 Node 测试、源码／打包应用完整 CRUD Electron 验证，以及 DMG／ZIP 首次启动、双语复制和目录配置验证已完成，证据保留在 [1.3.0 验证报告](release-local/VERIFICATION.md)。1.4.0 安装器仍在修复和统一最终验证中；当前文档不声称 1.4.0 全部测试或真实升级已经通过，最终结果以 `release-update/` 交付报告为准。

`npm run test:electron` 运行 `scripts/verify-crud.cjs`，使用独立 profile 和隔离素材目录，只关闭自身测试实例。验证实际文件写入、双语完整提示词复制、目录和图片选择流程、系统废纸篓与恢复记录，生成 `.verification/` 截图及 JSON 证据；不会用用户仓库作 CRUD 测试目录，也不清空系统废纸篓。

`npm run test:updates` 运行 `scripts/verify-updates.cjs`，在隔离 profile／发布目录验证版本窗口、来源持久化、版本比较、路径和校验失败等真实 IPC；原生目录选择结果由测试 fixture 提供，不请求安装或替换用户应用。安装器测试在临时目录执行真实文件替换，注入 verifier、extractor、waitForExit、handoff、launcher 和 stopUnconfirmed。中断用模拟异常后显式恢复；这类测试不能证明真实 OS 强杀后的自动恢复、Gatekeeper 已接受更新包或真实用户应用已经成功升级。

## Mac 打包

```bash
npm run package  # Apple Silicon .app
npm run dist:mac # Apple Silicon DMG + ZIP + updates.json
```

打包使用已安装的同版本 Electron，避免重复下载；镜像通过 macOS 自带 ditto/hdiutil 创建，原图与 React 资源一并打包，未使用的 Node 依赖不进入应用。

1.4.0 新产物位于 `release-update/`：

- `mac-arm64/Portrait Studio.app`
- `Portrait-Studio-React-1.4.0-arm64.dmg`
- `Portrait-Studio-React-1.4.0-arm64.zip`
- `updates.json`（含实际 ZIP 校验值与大小）

原 `release-react/` 的 1.1.0、`release-bilingual/` 的 1.2.0 和 `release-local/` 的 1.3.0 归档保持不动。已完成的 1.3 CRUD 交付仍可查看 [1.3.0 DMG](release-local/Portrait-Studio-React-1.3.0-arm64.dmg)、[ZIP](release-local/Portrait-Studio-React-1.3.0-arm64.zip) 和 [验证报告](release-local/VERIFICATION.md)；对应 Library 文件为 `libfile_fead8953e5148191a29f8d85d7da1ed0`，版本 `v0`。

DMG 提供应用与 Applications 拖拽入口，本项目不会自动安装。旧 `release/` 及运行中的旧实例保留。内置原图作为应用外部资源打包，可由 macOS 系统打开；安装包内资源只读，编辑需要另选本地素材目录。源码 ZIP 包含真实图片，不以 LFS 指针代替素材。

验证打包后的应用：

```bash
PORTRAIT_STUDIO_EXECUTABLE="$PWD/release-update/mac-arm64/Portrait Studio.app/Contents/MacOS/Portrait Studio" PORTRAIT_STUDIO_VERIFICATION_NAME=update-packaged-crud node scripts/verify-crud.cjs
PORTRAIT_STUDIO_EXECUTABLE="$PWD/release-update/mac-arm64/Portrait Studio.app/Contents/MacOS/Portrait Studio" PORTRAIT_STUDIO_VERIFICATION_NAME=update-packaged-ui node scripts/verify-updates.cjs
```

## 结构与安全

- `src/`：React 状态、侧栏、搜索、图库、双语详情、编辑表单、删除确认、本地更新窗口和 toast 组件。
- `styles.css`：原有配色与布局；固定视口滚动容器让底部图卡可访问。
- `assets/`：原有图片、逐字保留的英文及独立中文提示词数据。
- `main.js`：窗口、系统剪贴板与受限原图 IPC。
- `preload.js`：固定的复制、原图、素材列表／详情、原生目录／图片选择、待选图片释放（`releaseImage`）、CRUD，以及更新状态／来源／检查／准备／安装／renderer 就绪确认与状态订阅方法；不暴露任意 IPC 或文件系统访问。
- `local-electron.cjs`：原生选择器、图片授权凭据、受限 `portrait-media` 图片读取和本地 CRUD IPC。
- `local-library.cjs`：素材目录、索引、事务、系统废纸篓及旧素材恢复记录。
- `update-electron.cjs` / `update-service.cjs`：本地更新来源、manifest、语义化版本与受限更新 IPC。
- `local-update-installer.cjs`：更新包核验、独立 helper、应用备份替换、启动确认和受保护的回滚。
- `scripts/write-update-manifest.cjs`：为实际 ZIP 生成本地版本文档。
- `electron-security.cjs`：可信主 frame 验证、已知图片 allowlist 和真实路径检查。
- `vite.config.mjs`：React 构建到 `renderer-dist/`，使用本地相对资源。

生产开启 sandbox/contextIsolation/webSecurity，关闭 Node 集成，使用严格 CSP，禁止导航/新窗口/webview，拒绝权限请求。迁移前源码与素材在 `.verification/original/`。本次没有提交或推送。

## Git LFS 与按需下载

仅 `/assets/images/*.png` 使用 Git LFS；React 源码、提示词 JSON、文档和 lockfile 仍为普通 Git 文本。构建与 DMG/ZIP 输出目录继续忽略，不提交到 LFS。安装 `git-lfs` 后，在仓库内仅配置当前仓库：

```bash
git lfs install --local
```

当前普通 Git 索引中的 13 张原有 PNG 已全部为真实 LFS 指针：`001-natural-window.png` 的指针原已存在于 HEAD，另外 12 张的转换已暂存。13 个指针的 SHA-256 和长度均与工作区真实 PNG 一致，工作区图片原字节保持不变。`.gitattributes` 及 filter/hooks 仅配置当前仓库，不修改全局 Git 配置。本轮没有创建提交、推送或改写历史。

Git LFS 不压缩 PNG，也不自动缩减旧 Git 历史；已有历史中的普通图片 blob 仍保留。历史迁移会改变提交 SHA，需要协调已共享分支和强制推送，本轮没有执行。

默认 clone/checkout 可能自动下载当前版本的全部 LFS 素材。当前本地暂存的 12 张转换尚未提交或上传；以下按需下载示例适用于相应指针和 LFS 对象已上传的远端版本：

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

当前没有可用 Developer ID 凭据，不配置正式签名或公证（`identity: null`，`notarize: false`）。`afterPack` 使用 macOS 自带 codesign 生成本地 ad-hoc 完整性签名，不能作为发行者身份认证，也不代表通过 Gatekeeper。当前 ad-hoc 应用的 `spctl` 结果为 rejected，更新安装会停止；没有将绕过安全设置作为升级方法。1.3.0 已有证据见 `release-local/VERIFICATION.md`，1.4.0 最终结果以 `release-update/` 交付报告为准。本项目不移除 quarantine、不绕过 Gatekeeper，也不更改系统安全设置。

用户指定的 Library 参考图在两次授权下载后仍不可用；对照使用本 Mac 实际运行的原版截图，不声称完成该外部参考图的像素对照。

已有依赖的 npm audit 告警单独记录于验证报告；没有使用未经验证的主版本覆盖来消除告警。
