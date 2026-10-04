# Portrait Studio

React 19 + Vite + Electron 的本地图片与提示词素材库，当前源码版本 1.6.0。可管理不同题材的图片，没有人物或性别限制。保留深色布局、素材、搜索、疏密切换、详情和完整 English／中文复制；按本轮界面要求移除图库卡片的编号与名称，以及摄影／绘画分类入口。原始编号、名称、分类与来源资料仍保存在数据中。图片和提示词存放在应用外部的本机素材库；软件安装包不包含图库图片，也没有应用更新模块或云端服务。

本轮先交付浏览器预览，等待用户确认界面后再生成 1.6 安装包。封存的 1.0–1.5 软件与报告代表各自历史版本。

## 运行与检查

```sh
npm ci
npm start
npm run check
npm test
npm run test:batch
npm run test:electron
```

`npm start` 先构建 React，再启动 Electron。只读浏览器预览：

```sh
npm run dev -- --host 127.0.0.1 --port 5173
PORTRAIT_STUDIO_SINGLE_LANGUAGE_MODE=sidebar-motion node scripts/verify-single-language.cjs
```

打开 `http://127.0.0.1:5173/`。预览读取这台 Mac 的真实外部图库，当前是 50 张图片及其完整双语提示词；支持搜索、详情、语言设置、复制和疏密切换。导入、编辑、删除和原生选择目录只在 Mac 应用中可用，预览禁用这些入口。界面移除了快速复制提示、图卡查看提示、浏览器技术说明条、主区标题与说明及悬停复制说明。顶部紧凑固定栏中，搜索在左，素材管理图标在右，图库滚动时继续可见。素材管理面板包含导入、切换素材库、批量导入、刷新与保存路径；左下只保留设置图标，打开语言与主题面板。操作入口使用 SVG，短提示与无障碍名称随界面语言切换。

预览服务仅绑定 loopback，检查 Host、Origin、ID、索引版本、文件身份、哈希、大小与图片 MIME；接口只允许固定路径的 GET，没有任意文件访问或素材写入接口。生产构建不包含浏览器预览桥接代码，也不改变 Electron 安全设置。

`verify-single-language.cjs` 使用独立浏览器页面，按阶段检查全局唯一语言入口、持久化、提示词与复制、固定尺寸详情、主题与固定搜索栏，以及素材管理菜单的权限和真实刷新。当前窄增量验证使用 `sidebar-motion` 模式，关联并保留此前语言、复制、主题和管理菜单证据。复制检查仅捕获该测试页面传给 `navigator.clipboard.writeText` 的完整内容，不读取或改写系统剪贴板；它不代表原生选择器、CRUD 或安装包启动验证。

Apple Silicon Mac 打包：

```sh
npm run dist:mac
```

输出统一在 `release/`；此命令只在用户确认本轮预览后执行。DMG 提供应用与 Applications 拖拽入口，用户自行安装；本项目不自动安装。构建依赖来自标准 npm 源，没有新增付费服务。

历史版本 DMG 与 app ZIP 位于 `release/` 根目录，源码、截图证据、报告、元信息与运行时分别位于 `release/archives/<版本>/source/`、`evidence/`、`reports/`、`meta/`、`runtime/`。迁移只调整路径，保留原文件字节；路径映射与新校验索引见 `release/RELOCATION.json`、`release/ARCHIVE-SHA256SUMS`。原 `release/Portrait Studio.app` 和 1.0 DMG 保留原位。历史报告中的旧绝对路径及旧校验记录保留为当时事实；1.2 报告已有的历史校验差异单独记入迁移索引。

## 外部素材保存位置

这台 Mac 的默认素材库是 `/Users/jie/Github/photo_generate_desktop/photo_repo`，由 `assets/default-library.json` 指定。前端通过固定 IPC 读取元数据，并通过受限 `portrait-media://asset/<ID>` 协议读取后端验证后的图片，不使用安装包内图片、内嵌 base64 或默认复制图库。

顶部素材管理面板显示实际素材路径。选择目录后保存在该应用 profile，后续启动继续使用。曾保存为原项目根目录的旧配置会迁到这台 Mac 的 `photo_repo`；其他自选目录保持原配置。`PORTRAIT_STUDIO_LIBRARY_DIR` 可为测试提供独立目录，`PORTRAIT_STUDIO_USER_DATA_DIR` 可隔离 profile。

目录缺失、不可读或验证失败时显示提示和空态，可点击“选择保存文件夹”。选择空的可写目录会建立空索引；不会从安装包补图。重装软件不删除或改写外部素材库。保留原项目的旧素材文件与旧版本安装包，打包不需要它们。已有旧格式外部项目目录仍可读取 `assets/images/`、`assets/selected-prompts.json`、`assets/prompts.zh.json` 建立索引，但不会回写旧 JSON 或 Git。

## 批量导入

1. 连接可写素材库，在顶部素材管理菜单点击“批量导入”。
2. 通过 macOS 原生选择器选图片文件夹和包含完整提示词的 JSON。
3. 点击“生成导入预览”。原记录的分类资料保留；界面不要求用户为图片选择分类。
4. 核对来源路径、目标路径、逐项配对结果、冲突与异常，再确认导入。

JSON 是记录数组，每条记录需要唯一整数 `id`、名称 `label`、完整英文和中文提示词（如 `prompt_en`、`prompt_cn`）。导入只验证记录结构、确定配对及图片文件安全，不分析图片题材、人物或性别；PNG、JPEG、WebP 格式限制保持不变。显式图片文件名仅接受完全一致或同编号重复前缀的确定规范化匹配；没有文件名才允许唯一编号匹配。缺图、同编号多个候选、重复记录、越界路径或缺提示词均列出问题，不按数组顺序猜配，不补写翻译。提示词同语言别名同时存在时采用 `prompt_en`／`prompt_cn` 优先的固定规则，其他原字段完整保留为来源资料。

每张图片原字节复制到外部素材库，完整原记录存为 `sourceMetadata`；`sourceImport` 保存来源文件名、编号、哈希、配对规则、分类来源和归档路径。原始 JSON 按原字节归档，另存来源、映射和导入报告。原 manifest 中 `image_url`、`prompt_url` 等字段保留为来源资料，不作为远端取图地址。

相同编号且图片、双语提示词、名称、分类及原元数据完全一致时跳过；重复导入不增加图片、索引版本或归档。同编号不同内容列为冲突并保留现有素材。无歧义的新记录可单独导入，其余记录在报告中保留。预览期间可取消，不产生图片提交；确认时重新校验来源与索引版本。

提交使用独立批次事务：先留原始归档与恢复记录、暂存复制、再以单次原子索引替换完成批次。普通失败回滚本次新增副本；中断后重新打开库执行恢复。无法证明归属或发现外部修改时保留文件和恢复记录，提示冲突，不覆盖。原始图片文件夹和 JSON 不会被删除。

```text
photo_repo/assets/images/                         外部图片副本
photo_repo/.portrait-studio/library.json           完整双语索引、原始元数据、校验信息
photo_repo/.portrait-studio/imports/<批次ID>/       manifest.json、mapping.json、source.json、report.json
photo_repo/.portrait-studio/batch-transactions/    未完成批次恢复记录
photo_repo/.portrait-studio/recovery/<事务ID>/     CRUD 修改／删除前副本与记录
photo_repo/.portrait-studio/transactions/          CRUD 恢复记录
```

图库没有 50 张的固定限制；索引最多 10,000 条记录，列表读取完整元数据，图片按页面需要延迟加载。一次导入最多 500 条记录、1 GiB 匹配图片；单图最多 30 MiB，JSON 最多 32 MiB，单语言提示词最多 65,536 字符。图片需真实 PNG、JPEG 或 WebP 且可解码。

## 逐张管理与提示词

顶部素材管理菜单可逐张导入本机图片和完整中英提示词；详情可修改名称、提示词与替换图片。编辑保留原有内部分类及批导入来源资料。删除经过确认后仅把当前图片移到 macOS 系统废纸篓，并保留提示词及恢复记录。取消与冲突不提前改卡片。并发修改使用索引与条目版本校验，过期编辑保留输入供核对。

左下角设置面板是唯一的中文／English 语言入口，首次默认中文，设置保存在当前 profile。全局语言统一控制界面、提示词展示、卡片与快捷键及详情复制；旧的独立提示词语言设置不参与选择。复制使用所选语言全文，包含重复限制；详情切换图片或关闭不改变语言。用户名称、完整原始提示词和来源资料不自动翻译或改写。

同一设置面板支持深色／浅色主题，默认保持当前深色，选择保存在 `portraitStudio.theme`。主题覆盖主界面、详情、表单和弹窗，不改变素材图片。设置按钮具有键盘焦点与 ARIA 状态，面板支持 Escape、关闭按钮和点击外部关闭。

侧栏通过 SVG 箭头按钮展开或收起：展开宽度保持 250px，收起为 80px 图标栏，保留品牌标记、当前导航图标和可用设置入口，主区自然扩展。侧栏与主区以 200ms 同步伸缩，文字淡入前等待宽度展开，不挤压换行；系统偏好减少动态效果时取消该过渡。侧栏开关与搜索控件均为 38px 命中区、顶部 28px，中心保持同一水平线。状态保存在 `portraitStudio.sidebarCollapsed`，按钮使用当前语言的提示和 `aria-expanded`；收起时设置面板仍使用完整宽度。

详情弹窗以封存的 1.5 中文原生外框为基准：1440×920 和 2048×1280 视口使用 1030×696.3203125 CSS px，1080×720 使用 990×682 CSS px。切换界面或提示词语言不改变外框；正文在内部滚动，复制按钮保持可见。界面按钮、空态、错误、ARIA、表单和批导入报告按界面语言渲染；原生选择器的应用标题、说明、按钮与过滤器使用同一语言，系统自身窗口控件仍遵循 macOS 的语言设置。

## 安全与打包边界

主进程管理真实文件、原生选择器、废纸篓与剪贴板。preload 仅暴露固定 IPC 方法；renderer 没有任意文件读写能力。保持 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`，核验主 frame 来源，拒绝外部导航、弹窗和权限请求。素材协议校验目录、ID、库代次、条目版本、文件身份与哈希，拒绝任意路径或网络取图。

构建清单排除 `assets/images/`、`photo_repo/` 和 `node_modules/`，React 也不导入图库。最终 ASAR 和 Resources 需检查没有图库 PNG/JPEG/WebP、默认库或图片内嵌数据。品牌图标不属于图库。源码 ZIP 也不携带图库图片，工作区旧图片保留；旧素材兼容测试若没有原图或已封存参考会明确跳过，其他后端测试使用隔离临时素材。

构建使用本地 ad-hoc 签名（`codesign -s -`），不是 Developer ID 正式签名，也未公证；不能声称通过公开分发 Gatekeeper。验证不会绕过 Gatekeeper 或改变 macOS 安全设置。封存的 1.4 包已移到统一交付目录，文件字节保持不变，其更新功能不代表当前源码。

## 主要文件

- `src/App.jsx`、`src/components/`：React 页面、详情、双语复制、CRUD 与批导入界面。
- `main.js`、`preload.js`、`electron-security.cjs`：窗口安全和 IPC 边界。
- `local-electron.cjs`：选择器授权凭据、受限资源协议、外部库 CRUD／批导入 IPC。
- `local-library.cjs`：目录与索引校验、CRUD、恢复及批次接入。
- `batch-import.cjs`：只读 JSON 解析、确定匹配、来源固定与重新校验。
- `library-batch-transaction.cjs`：幂等判定、原始元数据归档、批次原子提交／恢复。
- `scripts/verify-batch-import.cjs`：隔离库的真实 Electron 批导入与双语复制检查。
- `src/i18n.jsx`、`src/ui-messages.json`、`system-messages.json`、`localization.cjs`：界面及原生适配双语消息、持久化语言偏好和安全错误说明。
- `preview-library.cjs`、`src/preview-bridge.js`、`vite.config.mjs`：开发时的真实图库只读浏览器预览。
- `src/components/Settings.jsx`：左下角设置面板，全局语言与持久化主题切换。
- `src/components/LibraryMenu.jsx`：顶部素材管理图标菜单，保留四个素材操作的真实回调与权限控制。
- `scripts/verify-single-language.cjs`：全局唯一语言、完整提示词、固定外框及设置／主题／固定搜索栏的窄浏览器验收。
- `scripts/verify-i18n.cjs`：封存的中文原生尺寸基准与此前独立提示词方案的验收脚本；当前预览使用上项脚本，旧报告保留当时事实。

原 PNG 的 Git LFS 工作与用户已有改动保持现状。本轮不提交、推送或改写历史，也不自动安装到 Applications。1.5 封存包的验证报告与原校验记录位于 `release/archives/1.5.0/reports/` 和 `meta/`；本轮最新预览证据在 `.verification/i18n-sidebar-motion-verification.json`，此前阶段证据也保留，不作为尚未生成的 1.6 安装包验证结果。
