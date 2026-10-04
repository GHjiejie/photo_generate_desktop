# Portrait Studio：固定 admin 平台服务部署

当前交付针对 Go 服务、固定 `admin` 登录与已有 100 张素材。它不再使用旧 dashboard Basic 登录方案。助手只准备和隔离验证这些文件，没有连接或部署服务器，没有初始化生产密码，没有修改线上 Caddy。服务器当前目录、服务、数据和路由仍未核实。

## 唯一本机执行入口

目标固定为 `ubuntu@18.180.65.241`，目录 `/home/ubuntu/portrait-studio`，服务用户 `ubuntu`，Go 仅监听 `127.0.0.1:4137`。SSH 使用你已有的系统配置及已验证的 `known_hosts`，不关闭主机密钥检查、不转发认证代理、不修改 SSH、防火墙或安全设置。服务器需要相应 `sudo -n` 权限。

先审阅 `platform_admin/` 内的本机入口、服务器阶段、Caddy 验证器、清单及服务单元。默认或 `--prepare` 仅做本地预检，不使用 SSH：

```sh
cd /Users/jie/Github/photo_generate_desktop
python3 server/deploy/platform_admin/deploy_from_mac.py --prepare
```

审阅完成后，需要你做的唯一启动动作是：

```sh
python3 server/deploy/platform_admin/deploy_from_mac.py --apply
```

入口串行处理本地校验、服务器现状检查、具体计划确认、私下初始化 admin、服务激活及结果验证。终端内的确认和隐藏密码输入都需你本人完成。你须看到私有候选配置的服务器绝对路径、原配置与候选 SHA-256、完整新增的公开 Caddy 块，再按提示确认具体 hash。取消、初始化失败、现状漂移或无法证明路由保护时停止。

本人运行 `--apply` 后，入口先建立私有临时传输目录并上传已校验的交付，再在服务器私下生成和验证候选计划。正式应用目录、服务单元和 Caddy 安装在具体 SHA 确认后才开始；admin 初始化成功前不激活站点或服务。本地回执在首次远程操作前保存，便于失败或取消后审阅归属。

本轮没有运行上述生产执行命令。不要把密码、私有凭据文件或完整 Caddy 配置发到聊天。

## 私下初始化密码与默认拒绝

只有一个内置用户名 `admin`，没有注册、用户管理或默认密码。配置缺失时业务 API 返回 `AUTH_NOT_INITIALIZED`；错误或冲突配置拒绝启动。所有图库读取、图片、CRUD、上传和批量操作都需要 Go 发出的有限期 Bearer 会话；退出撤销服务端会话，重启使原会话失效。

入口在独立的 SSH 终端中运行 Go `init-admin`，输入直接交给你本人，不与传输部署脚本的 stdin 混流。密码至少 12 个字符、最多 1024 个 UTF-8 字节，不含控制字符；隐藏输入并确认两次。Go 只写随机盐的 Argon2id 哈希配置。脚本不接受密码参数，不保存、读取、回显密码或哈希，不提供预设 secret。

凭据目录 0700、文件 0600，属于服务用户并位于图库之外。已有配置不覆盖、不打印、不复制到 Mac。初始化失败不启用未保护图库。若必须人工处理，只能由你本人以服务用户 `ubuntu` 身份在服务器私有终端执行：

```sh
install -d -m 700 /home/ubuntu/portrait-studio/config
/home/ubuntu/portrait-studio/bin/portrait-server init-admin \
  -auth-file /home/ubuntu/portrait-studio/config/admin-auth.json
```

这个生产命令尚未执行。环境配置见 [`.env.example`](../.env.example)；服务不自动加载 `.env`，不支持明文密码环境变量。

## Caddy：只新增图库站点，不移动原认证

主方案新增独立 HTTPS 域名 `portrait-18-180-65-241.sslip.io`，计划地址：

```text
https://portrait-18-180-65-241.sslip.io/portrait-studio/
```

地址不表示已经上线。仅 `/portrait-studio/*` 去除前缀后代理至 Go 的固定回环端口，其余路径 404。结构示例见 [`caddy-platform-auth.example`](caddy-platform-auth.example)，实际审批以入口公示的完整新增块为准。Authorization 原样交给 Go；健康和认证初始化端点之外的图库访问由 Go 验证 token。

旧 dashboard 和其他站点的原始配置、Basic 账号、哈希、认证顺序与 TLS 保护不修改。不移走或删除原 Basic，不猜旧密码，也不将新平台登录放在旧 Basic 挑战之后。

本人批准新增块后，服务器分别适配原配置和候选配置，证明所有旧有效路由、顺序、认证、TLS 语义不变，并验证新站点只有固定图库代理和 404。无法证明的 import、共享/通配站点、全局配置或自定义顺序等情况会停止，不自动改写，也不自动退回同域名重构。

若坚持旧 dashboard 域名，需要另行在服务器私有环境审阅完整配置：明确有序的 `route` 先匹配图库前缀，再将全部原处理器及原 Basic 一起放入回退 handle。只在 site-wide `basic_auth` 后追加 `handle_path` 仍会要求旧密码。本次脚本不自动执行这种认证重构。

## 复用 100 素材与保护现有数据

直接复用已审核的两份文件，不重新导出：

```text
server/dist/Portrait-Studio-Library-100-r3.tar.gz
server/dist/Portrait-Studio-Library-100-r3.tar.gz.manifest.json
```

归档 227,072,304 字节，SHA-256 为 `390cc75dde3c6f44aad0e12ff6a840423ff1199fb9be6867c7b3678e5d2d0799`；sidecar 22,885 字节，SHA-256 为 `752120a072a348add59ff06024649dcc841375a4e7b018b8c3e6a4fcf3630f76`。包含 100 张图片、revision 3 索引、完整中英文提示词、原始导入清单和来源元数据，共 108 个文件。

本 Mac 工程直接复用现有文件。工具附件不重复包含约 227 MB 的素材；另一台 Mac 需将原归档和 sidecar 另行复制到同样的 `server/dist/` 位置。清单绑定两个 hash，解压前后逐文件验证，不接受符号链接、路径穿越、重复或额外条目。

本入口只支持无现有冲突的全新安装，不自动升级旧 Basic 服务。发现已有目录、同名服务、占用端口、已有图库或该前缀路由时，停止供审阅，不覆盖或重置。配置备份及已安装的二进制、素材和私有证据保留并核对状态。原本机 `photo_repo`、Downloads、封存包及用户应用保持原样。

## 验证和回滚

本地隔离测试不等于 Ubuntu systemd、实际 Caddy TLS 或公共域名已工作。成功状态要求新服务版本与初始化状态正确，未登录业务访问为 Go 的 401，健康/认证路由可达，并保持原站点保护。随后仍需你在源码桌面客户端私下登录，确认真实远程的 100 条图库、图片及核心操作。上传完成不等于部署完成。

回滚默认只显示本地回执和计划，不连接服务器：

```sh
python3 server/deploy/platform_admin/deploy_from_mac.py --rollback
```

本人审阅确认后，才运行带执行标志的同一入口：

```sh
python3 server/deploy/platform_admin/deploy_from_mac.py --rollback --apply
```

回滚核对当前配置和服务仍为本次记录的 hash，发现他人的后续修改就停止。仅撤回本次新增站点和服务，保留素材、凭据、备份及私有证据，不回写旧图库快照而丢失后续内容。

旧根目录 `deploy_from_mac.py`、`deploy_server.py`、`manual-deployment-manifest.json`、Basic 服务单元和旧工具 zip 只供历史审计，不能用于新平台认证，不解除其 hash 检查强行执行。本轮不制作新 Mac 包；封存 1.6 包不含后续服务器/鉴权变更。
