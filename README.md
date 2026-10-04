# Portrait Studio

React 19 + Vite + Electron 本地桌面应用，当前源码版本 1.6.0。前端与素材后端默认全部在这台 Mac 运行，无需服务器地址或登录。可管理不同题材的图片，没有人物或性别限制。保留深色布局、素材、搜索、疏密切换、详情和完整 English／中文复制；按本轮界面要求移除图库卡片的编号与名称，以及摄影／绘画分类入口。原始编号、名称、分类与来源资料仍保存在数据中。本地后端管理外部 `photo_repo` 的图片、完整双语提示词及来源资料，桌面通过固定 IPC 操作。软件安装包不包含图库图片，也没有应用更新模块。

已封存的 1.6.0 安装包沿用用户确认的界面与真实桌面功能。当前源码新增单目录批量导入并恢复默认本地后端；本轮没有重新生成安装包，已有 1.6.0 包不包含这些新增源码功能。远程 Go 及认证源码保留为显式可选模式，服务器部署已取消。封存的 1.0–1.5 软件与报告代表各自历史版本。

## 运行与检查

```sh
npm ci
npm start
npm run check
npm test
npm run test:server
npm run test:remote
```

`npm run test:electron`／`npm run test:batch` 使用隔离本地图库与 profile 验证桌面功能。可选 `npm run test:server` 使用本机 Go 运行临时存储测试。`npm run test:remote` 必须配置 `PORTRAIT_STUDIO_REMOTE_TEST_BASE_URL` 和 `PORTRAIT_STUDIO_REMOTE_TEST_LIBRARY_LABEL`，连接明确标记的空白临时测试服务；脚本拒绝默认真实素材库。默认本地运行不需要启动 Go 或任何服务器。

`npm start` 先构建 React，再启动 Electron，默认读取 `/Users/jie/Github/photo_generate_desktop/photo_repo`。左下角设置显示本地保存路径，可通过原生选择器切换素材库；无需配置远程地址或平台账号。启动时先确定后端，preload 只接收本地主进程提供的固定模式标记；旧的远程地址、认证环境变量和连接配置不会自动启用远程模式。

只有显式设置 `PORTRAIT_STUDIO_BACKEND=remote` 才启用保留的远程模式及以下认证功能。该模式中，`PORTRAIT_STUDIO_REMOTE_BASE_URL` 可覆盖地址；已有认证可通过 `PORTRAIT_STUDIO_REMOTE_AUTHORIZATION` 提供，仅保留在主进程内存，不交给 renderer。界面保存仅允许 HTTPS，无 URL 用户名、密码、查询或片段；开发版环境变量允许明确的 loopback HTTP 测试地址。保存地址不代表远端已可用；连接失败时禁用远程写入，显示具体连接状态。

平台内置唯一账号 `admin`，没有用户增删改查、注册或通用默认密码。服务器管理员通过本地隐藏输入初始化密码，保存 Argon2id 哈希，并通过环境参数或秘密配置启动服务；步骤与占位配置见 [服务认证说明](server/README.md) 和 [server/.env.example](server/.env.example)。不要把真实密码、哈希或 token 放入源码、聊天、URL、日志或交付附件。

配置 HTTPS 地址后，从服务器设置选择“平台登录”才会打开独立本地窗口，账号固定为 `admin`。密码输入遮蔽，登录成功交换有限期访问 token，所有图库读写、图片与上传均需该 token。完整图库响应通过验证后才显示已连接。密码和 token 不交给图库 renderer；token 仅留在主进程内存，重启需重新登录。设置可显示账号、到期时间和退出入口；退出会请求服务端撤销并清除本地会话，若网络失败则明确仅完成本地退出。401 或过期会清理本地会话和旧素材选择，禁用写入并提示重新登录。取消会清空并关闭密码窗口；切换服务器地址清除旧会话。

远程部署已按用户要求停止。保留的 [平台专用 Caddy 方案](server/deploy/caddy-platform-auth.example) 和 [用户执行入口](server/deploy/USER-DEPLOY.md) 是历史准备成果，不是当前本地启动步骤，也不代表已部署。用户先前运行曾完成四个上传文件；经逐项哈希核对和用户明确永久删除确认，这四个文件及空临时目录已删除，本地原文件保留。未创建本次专属服务；当前 Caddyfile 解析结果中未见本次专属域名或 4137 上游，清理没有修改 Caddy 或其他站点。独立删除证据保留在 `.verification/cancelled-server-stage-deletion-20261004.json`。

Go 构建、接口和待审核部署文件见 [server/README.md](server/README.md)。最终公网访问需要现有 TLS 站点及全路径认证；SSH 转发只用于开发测试。实际部署状态见本轮验证报告，源码文件不代表已部署。只读浏览器预览：

```sh
npm run dev -- --host 127.0.0.1 --port 5173
PORTRAIT_STUDIO_SINGLE_LANGUAGE_MODE=sidebar-motion node scripts/verify-single-language.cjs
```

打开 `http://127.0.0.1:5173/`。预览通过 Node 侧固定只读接口读取同一个本地 `photo_repo`；支持搜索、详情、语言设置、复制和疏密切换。导入、编辑、删除和原生选择目录只在 Mac 应用中可用，预览禁用这些入口。界面移除了快速复制提示、图卡查看提示、浏览器技术说明条、主区标题与说明及悬停复制说明。顶部紧凑固定栏中，搜索在左，素材管理图标在右，图库滚动时继续可见。素材管理面板包含导入、切换素材库、批量导入、刷新与保存路径；左下只保留设置图标，打开语言与主题面板。操作入口使用 SVG，短提示与无障碍名称随界面语言切换。

预览服务仅绑定 loopback，检查 Host、Origin、ID、索引版本、文件身份、哈希、大小与图片 MIME；接口只允许固定路径的 GET，没有任意文件访问或素材写入接口。生产构建不包含浏览器预览桥接代码，也不改变 Electron 安全设置。

`verify-single-language.cjs` 使用独立浏览器页面，按阶段检查全局唯一语言入口、持久化、提示词与复制、固定尺寸详情、主题与固定搜索栏，以及素材管理菜单的权限和真实刷新。当前窄增量验证使用 `sidebar-motion` 模式，关联并保留此前语言、复制、主题和管理菜单证据。复制检查仅捕获该测试页面传给 `navigator.clipboard.writeText` 的完整内容，不读取或改写系统剪贴板；它不代表原生选择器、CRUD 或安装包启动验证。

Apple Silicon Mac 打包：

```sh
npm run dist:mac
```

输出统一在 `release/`：`Portrait-Studio-React-1.6.0-arm64.dmg`、`Portrait-Studio-React-1.6.0-arm64.zip`；源码与验证报告位于 `release/archives/1.6.0/`。DMG 提供应用与 Applications 拖拽入口，用户自行安装；本项目不自动安装。构建依赖来自标准 npm 源，没有新增付费服务。

历史版本 DMG 与 app ZIP 位于 `release/` 根目录，源码、截图证据、报告、元信息与运行时分别位于 `release/archives/<版本>/source/`、`evidence/`、`reports/`、`meta/`、`runtime/`。迁移只调整路径，保留原文件字节；路径映射与新校验索引见 `release/RELOCATION.json`、`release/ARCHIVE-SHA256SUMS`。原 `release/Portrait Studio.app` 和 1.0 DMG 保留原位。历史报告中的旧绝对路径及旧校验记录保留为当时事实；1.2 报告已有的历史校验差异单独记入迁移索引。

## 本地素材库

当前默认读写这台 Mac 的外部 `photo_repo`。下载来源只读，新增导入复制原始图片，不删除或改写来源。被取消的服务器存储路径不参与本地运行。

2026-10-04 已通过本地生产导入入口新增 Downloads 中的 50 张图片，真实图库达到 100 条、索引 revision 3。原有 50 条完整记录及 54 个非索引文件保持原样；新增内部编号为 51–100，原始来源编号 1–50 单独保留。完整英文和原始 JSON 不变，中文复用已核验的完整派生翻译，并独立记录原文、译文和来源哈希。下载来源的 52 个文件未修改。实际结果见 `.verification/local-import-result.json`；此前的 `local-import-plan.json` 是此次提交前的只读计划，不可再次按旧 revision 提交。

这台 Mac 的默认素材库是 `/Users/jie/Github/photo_generate_desktop/photo_repo`；源码启动从项目下的 `photo_repo` 读取，打包启动默认由 `assets/default-library.json` 指定。前端通过固定 IPC 读取元数据，并通过受限 `portrait-media://asset/<ID>` 协议读取后端验证后的图片，不使用安装包内图片、内嵌 base64 或默认复制图库。

设置和顶部素材管理面板显示实际素材路径。选择目录后保存在该应用 profile，后续启动继续使用。曾保存为原项目根目录的旧配置会迁到这台 Mac 的 `photo_repo`；其他自选目录保持原配置。`PORTRAIT_STUDIO_LIBRARY_DIR` 可为测试提供独立目录，`PORTRAIT_STUDIO_USER_DATA_DIR` 可隔离 profile。

目录缺失、不可读或验证失败时显示提示和空态，可点击“选择保存文件夹”。选择空的可写目录会建立空索引；不会从安装包补图。重装软件不删除或改写外部素材库。保留原项目的旧素材文件与旧版本安装包，打包不需要它们。已有旧格式外部项目目录仍可读取 `assets/images/`、`assets/selected-prompts.json`、`assets/prompts.zh.json` 建立索引，但不会回写旧 JSON 或 Git。

## 批量导入

1. 连接可写素材库，在顶部素材管理菜单点击“批量导入”。
2. 通过 macOS 原生选择器选一个来源文件夹；自动发现其中的 JSON 清单和图片，支持根目录清单配合图片子目录。只有一份有效清单时自动选中；多份时在弹窗中明确选择一份。
3. 点击“生成导入预览”。原记录的分类资料保留；界面不要求用户为图片选择分类。预览显示相对图片路径及缺少清单、提示词、图片或配对歧义等问题。
4. 核对来源路径、目标路径、逐项配对结果、冲突与异常，再确认导入。

JSON 支持记录数组或包含 `images` 记录数组的对象；每条记录需要唯一整数 `id`、名称 `label`、完整英文和中文提示词（如 `prompt_en`、`prompt_cn`）。导入只验证记录结构、确定配对及图片文件安全，不分析图片题材、人物或性别；PNG、JPEG、WebP 格式限制保持不变。显式根目录相对路径优先精确匹配；仅有文件名时必须在整个来源目录中唯一，或能按同编号重复前缀确定规范化匹配；没有文件名才允许唯一编号匹配。缺图、同编号多个候选、重复记录、越界路径或缺提示词均列出问题，不按数组顺序猜配，不补写翻译。提示词同语言别名同时存在时采用 `prompt_en`／`prompt_cn` 优先的固定规则，其他原字段完整保留为来源资料。

每张图片原字节复制并保存到本地素材库，完整原记录存为 `sourceMetadata`；`sourceImport` 保存来源文件名、相对路径、编号、哈希、配对规则、分类来源和归档路径。整个原始 JSON（包括对象外层字段）按原字节归档，另存来源、映射和导入报告。原 manifest 中 `path`、`image_url`、`prompt_url` 等字段保留为来源资料，不作为外部或远端取图地址。

本地导入按图片 SHA-256 幂等跳过；重复导入不增加图片、索引版本或归档。普通导入的编号冲突列为问题；经明确授权的迁移可采用下述新内部编号策略，并保留现有素材与来源编号。无歧义的新记录可单独导入，其余记录在报告中保留。预览期间可取消，不产生图片提交；确认时重新校验来源与索引版本。

经明确授权的新增导入可在主进程指定 `collisionPolicy: 'allocate-new'`：相同图片 SHA-256 跳过，不同图片遇到来源编号碰撞时分配新的内部编号。来源编号单独存为 `sourceImport.sourceId`，映射记录来源与目标编号。明确提供的完整中文翻译可补充缺失中文；译文、原文及译文哈希存为衍生来源记录，`sourceMetadata` 和归档 JSON 仍保持原始英文资料。普通目录预览不会自动生成翻译或覆盖来源中文，renderer 没有新增的衍生导入权限。

提交使用独立批次事务：先留原始归档与恢复记录、暂存复制、再以单次原子索引替换完成批次。普通失败回滚本次新增副本；中断后重新打开库执行恢复。无法证明归属或发现外部修改时保留文件和恢复记录，提示冲突，不覆盖。原始图片文件夹和 JSON 不会被删除。

```text
photo_repo/assets/images/                         外部图片副本
photo_repo/.portrait-studio/library.json           完整双语索引、原始元数据、校验信息
photo_repo/.portrait-studio/imports/<批次ID>/       manifest.json、mapping.json、source.json、report.json
photo_repo/.portrait-studio/batch-transactions/    未完成批次恢复记录
photo_repo/.portrait-studio/recovery/<事务ID>/     CRUD 修改／删除前副本与记录
photo_repo/.portrait-studio/transactions/          CRUD 恢复记录
```

图库没有 50 张的固定限制；索引最多 10,000 条记录，列表读取完整元数据，图片按页面需要延迟加载。发现范围最多 3 层子目录、5,000 个条目、32 份 JSON，JSON 总量最多 64 MiB；拒绝符号链接和来源目录之外的路径，超过限额会提示重新选择。一次导入最多 500 条记录、1 GiB 匹配图片；单图最多 30 MiB，JSON 最多 32 MiB，单语言提示词最多 65,536 字符。图片需真实 PNG、JPEG 或 WebP 且可解码。

## 逐张管理与提示词

顶部素材管理菜单可逐张导入本机图片和完整中英提示词；详情可修改名称、提示词与替换图片。编辑保留原有内部分类及批导入来源资料。删除经过确认后在外部素材库恢复目录保留完整原记录与图片；本机原生删除同时使用 Mac 系统废纸篓。取消与冲突不提前改卡片。并发修改使用索引与条目版本校验，过期编辑保留输入供核对。

左下角设置面板是唯一的中文／English 语言入口，首次默认中文，设置保存在当前 profile。全局语言统一控制界面、提示词展示、卡片与快捷键及详情复制；旧的独立提示词语言设置不参与选择。复制使用所选语言全文，包含重复限制；详情切换图片或关闭不改变语言。用户名称、完整原始提示词和来源资料不自动翻译或改写。

同一设置面板支持深色／浅色主题，默认保持当前深色，选择保存在 `portraitStudio.theme`。主题覆盖主界面、详情、表单和弹窗，不改变素材图片。设置按钮具有键盘焦点与 ARIA 状态，面板支持 Escape、关闭按钮和点击外部关闭。

侧栏通过 SVG 箭头按钮展开或收起：展开宽度保持 250px，收起为 80px 图标栏，保留品牌标记、当前导航图标和可用设置入口，主区自然扩展。侧栏与主区以 200ms 同步伸缩，文字淡入前等待宽度展开，不挤压换行；系统偏好减少动态效果时取消该过渡。展开态 Logo、两行品牌文案、侧栏开关与搜索控件的中心均为 Y=47px；开关和搜索控件为 38px 命中区、顶部 28px。状态保存在 `portraitStudio.sidebarCollapsed`，按钮使用当前语言的提示和 `aria-expanded`；收起时设置面板仍使用完整宽度。

详情弹窗以封存的 1.5 中文原生外框为基准：1440×920 和 2048×1280 视口使用 1030×696.3203125 CSS px，1080×720 使用 990×682 CSS px。切换界面或提示词语言不改变外框；正文在内部滚动，复制按钮保持可见。界面按钮、空态、错误、ARIA、表单和批导入报告按界面语言渲染；原生选择器的应用标题、说明、按钮与过滤器使用同一语言，系统自身窗口控件仍遵循 macOS 的语言设置。

## 安全与打包边界

本地后端管理持久素材与业务事务；主进程管理选择器、受验证原图及剪贴板。preload 仅暴露固定 IPC 方法和主进程确定的后端模式；renderer 没有任意文件读写能力。保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`，核验主 frame 来源，拒绝外部导航、弹窗和权限请求。素材协议校验目录、ID、库代次、条目版本、文件身份与哈希，拒绝任意路径或网络取图。

构建清单包含本地 CRUD、批次事务模块和指向外部目录的默认配置，排除 `assets/images/`、`photo_repo/` 和 `node_modules/`，React 也不导入图库。未来重新打包时，最终 ASAR 和 Resources 需检查没有图库 PNG/JPEG/WebP 或图片内嵌数据。品牌图标不属于图库。源码 ZIP 也不携带图库图片，工作区旧图片保留；旧素材兼容测试若没有原图或已封存参考会明确跳过，其他后端测试使用隔离临时素材。本轮只修正构建清单，没有覆盖任何封存包。

构建使用本地 ad-hoc 签名（`codesign -s -`），不是 Developer ID 正式签名，也未公证；不能声称通过公开分发 Gatekeeper。验证不会绕过 Gatekeeper 或改变 macOS 安全设置。封存的 1.4 包已移到统一交付目录，文件字节保持不变，其更新功能不代表当前源码。

## 主要文件

- `src/App.jsx`、`src/components/`：React 页面、详情、双语复制、CRUD 与批导入界面。
- `main.js`、`preload.js`、`electron-security.cjs`：窗口安全和 IPC 边界。
- `auth-dialog.cjs`、`auth-preload.js`、`auth.html`：独立安全登录窗口；现有账号仅保留于主进程内存。
- `remote-client.cjs`、`remote-electron.cjs`、`remote-source.cjs`：固定远程 API、仅原字节上传与来源安全校验、受限资源协议、完整当前语言复制与临时原图。
- `server/`：保留的可选 Go 持久化、CRUD、严格批次配对、事务与恢复；默认本地无需运行。
- `local-electron.cjs`：默认本地 IPC、原生选择器、媒体和双语复制适配。
- `local-library.cjs`：目录与索引校验、CRUD、恢复及批次接入。
- `batch-import.cjs`：只读 JSON 解析、确定匹配、来源固定与重新校验。
- `library-batch-transaction.cjs`：幂等判定、原始元数据归档、批次原子提交／恢复。
- `scripts/verify-batch-import.cjs`：隔离库的真实 Electron 批导入与双语复制检查。
- `src/i18n.jsx`、`src/ui-messages.json`、`system-messages.json`、`localization.cjs`：界面及原生适配双语消息、持久化语言偏好和安全错误说明。
- `preview-library.cjs`、`src/preview-bridge.js`、`vite.config.mjs`：默认本地只读浏览器预览；显式远程模式使用 `remote-preview.cjs`。
- `scripts/import-local-portraits.cjs`：固定来源的严格只读计划与显式授权提交入口；只读计划不打开真实库写入。
- `src/components/Settings.jsx`：左下角设置面板，全局语言与持久化主题切换。
- `src/components/LibraryMenu.jsx`：顶部素材管理图标菜单，保留四个素材操作的真实回调与权限控制。
- `scripts/verify-single-language.cjs`：全局唯一语言、完整提示词、固定外框及设置／主题／固定搜索栏的窄浏览器验收。
- `scripts/verify-i18n.cjs`：封存的中文原生尺寸基准与此前独立提示词方案的验收脚本；当前预览使用上项脚本，旧报告保留当时事实。

原 PNG 的 Git LFS 工作与用户已有改动保持现状。本轮不提交、推送或改写历史，也不自动安装到 Applications。1.6.0 封存包及其报告位于 `release/` 和 `release/archives/1.6.0/`；当前远程流程和历史单目录流程的源码检查与桌面验证证据另存 `.verification/`，不覆盖旧包的验证结果。
