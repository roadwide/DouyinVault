# Mac mini 部署与远程访问

本文使用 `vault.example.com` 作为示例域名，请替换为你自己的域名。实际部署记录应保存在被 Git 忽略的 `docs/*.local.md` 中。

目标：Mac mini 上常驻运行，手机与电脑通过 HTTPS 安全访问。

## 1. 前置条件

- macOS（Apple Silicon 或 Intel）
- Node.js 22.13+（建议锁定一个经过测试的 22 LTS 版本；douyin-im 使用 node:sqlite）
- pnpm 10
- ffmpeg / ffprobe
- 可选：yt-dlp
- 可选：独立运行的 Douyin_TikTok_Download_API
- 一个 Cloudflare 账号与域名 `example.com`

```bash
brew install node@22 pnpm ffmpeg
node -v
pnpm -v
ffmpeg -version | head -1
ffprobe -version | head -1
```

如果使用 yt-dlp：

```bash
brew install yt-dlp
# 或
python3 -m pip install -U yt-dlp
```

## 2. 安装

```bash
git clone https://github.com/roadwide/DouyinVault.git
cd DouyinVault
cp .env.example .env
chmod 600 .env
bash scripts/install.sh
```

或手动：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
```

> 尚未完成 Phase 0 时，不要把真实账号长期运行。先用两个受控群聊按 [acceptance.md](acceptance.md) 验证。

## 3. 配置 `.env`

最小生产示例：

```dotenv
NODE_ENV=production
LOG_LEVEL=info
LOG_PRETTY=false

HOST=127.0.0.1
PORT=18760
DATA_DIR=./data
PUBLIC_ORIGIN=https://vault.example.com

# 推荐留空，使用一次性安装令牌；设置后会直接初始化密码。
ADMIN_PASSWORD=

IM_ADAPTER=douyin-im
DEMO_MODE=false

# 可选：独立下载 API
DTK_BASE_URL=http://127.0.0.1:8000
DTK_API_KEY=
DTK_MODE=auto

YTDLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
FFPROBE_PATH=ffprobe
```

说明：

- `HOST` 必须是 `127.0.0.1`，不要直接绑定 `0.0.0.0`。
- `PUBLIC_ORIGIN` 用于 CSRF Origin 校验，必须与浏览器实际打开的 Origin 完全一致。
- 不建议在 `.env` 长期保存管理员密码；首次使用 `ADMIN_PASSWORD` 会写入 scrypt 哈希，随后删掉该变量或留空都不会改变已设置密码。
- `DTK_API_KEY` 只由服务端读取，不返回前端。

## 4. 首次启动与管理员密码

前台测试：

```bash
pnpm start
```

另一个终端：

```bash
pnpm setup-token
```

打开 <http://127.0.0.1:18760>，粘贴令牌，设置至少 10 个字符的管理员密码。令牌文件会在成功后删除。

也可以直接设置 `.env` 的 `ADMIN_PASSWORD`，重启后使用该密码登录。

## 5. 安装为 launchd 服务

```bash
bash scripts/install-launchd.sh
```

默认服务标识为 `local.douyinvault`。已有部署如使用其他标识，可将标识单独写入 `deploy/launchd-label.local`（已忽略），或通过 `VAULT_LAUNCHD_LABEL` 环境变量覆盖；下文 `launchctl` 命令中的标识也需相应替换。

脚本会：

- 生成 `~/Library/LaunchAgents/local.douyinvault.plist`
- 记录当前 `node` 的绝对路径
- 设置 `NODE_ENV=production`
- 在用户登录后自动启动
- 异常退出后自动重启
- 日志写入 `data/logs/launchd.out.log` 与 `launchd.err.log`

launchd 的 stdout/stderr 不会自动轮转；长期运行请用 `newsyslog`、`logrotate` 或定期归档 `data/logs/`。不要把日志直接公开上传。

常用操作：

```bash
# 重启
launchctl kickstart -k gui/$(id -u)/local.douyinvault
# 状态
launchctl print gui/$(id -u)/local.douyinvault | head -40
# 卸载
bash scripts/uninstall-launchd.sh
# 健康检查
pnpm healthcheck
```

注意：

- LaunchAgent 只在 **该 macOS 用户登录桌面后**运行。
- 如果需要“无人登录也启动”，需要改用 LaunchDaemon，以非 root 用户运行，并单独验证：
  - douyin-im 登录与设备信息是否依赖桌面环境
  - Session 目录权限
  - 浏览器备用适配器的 profile 权限
  - 系统休眠/网络切换后的重连
- **启动进程成功 ≠ 抖音已连接**。在仪表盘确认账号状态、上次收消息时间与群同步状态。

## 6. Cloudflare Tunnel

### 6.1 创建 Tunnel

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create douyin-vault
```

记下 Tunnel UUID 与凭据文件路径。

### 6.2 配置

复制 `deploy/cloudflared/config.yml.example` 到 `~/.cloudflared/config.yml`，替换：

- `REPLACE_WITH_TUNNEL_UUID`
- `credentials-file` 中的用户名与 UUID

```yaml
tunnel: <UUID>
credentials-file: /Users/<user>/.cloudflared/<UUID>.json

ingress:
  - hostname: vault.example.com
    service: http://127.0.0.1:18760
    originRequest:
      connectTimeout: 30s
      noHappyEyeballs: true
  - service: http_status:404
```

### 6.3 DNS 与启动

```bash
cloudflared tunnel route dns douyin-vault vault.example.com
cloudflared tunnel run douyin-vault     # 前台测试
sudo cloudflared service install        # 安装为系统服务
```

打开 `https://vault.example.com`，确认能加载登录页。

### 6.4 Cloudflare Access

在 Cloudflare Zero Trust 中：

1. 创建 Access Application：`vault.example.com`。
2. 策略设为仅允许你的邮箱 / 身份提供商 / 一次性 PIN。
3. 会话时长按需设置（例如 24 小时）。
4. 可选：开启 WARP 或仅限特定国家/设备。
5. 不要创建绕过策略的公开路径。

应用自身仍需管理员密码。Cloudflare Access 是外层防线，不是替代品。

### 6.5 验证远程安全

- [ ] 直接访问 `http://<公网IP>:18760` 失败（端口未暴露）
- [ ] 本机直连 `http://127.0.0.1:18760/api/v1/system/status` 未登录返回 401
- [ ] 本机直连视频流 URL 未登录返回 401
- [ ] 公网 `https://vault.example.com` 未通过 Access 时跳转到 Cloudflare Access 登录页
- [ ] Cloudflare Access 未通过时无法看到应用页面
- [ ] 响应头没有暴露内部路径
- [ ] `cloudflared` 日志与 `data/logs` 不含 Cookie/签名 URL

## 7. 初始化抖音连接

1. 登录管理后台。
2. 仪表盘点击「连接抖音」。
3. 用抖音 App 扫描二维码；若出现 `VERIFY_REQUIRED`，按页面提示在运行服务的设备上完成官方验证。
4. 连接成功后打开「群聊」，点击「刷新群列表」。
5. 逐个启用需要监听的群。**所有群默认关闭，新群不会自动启用。**
6. 手动机密群补拉一次，观察「最近成功同步」与「历史缺口」提示。
7. 在受控群发送一条视频分享，确认：
   - 消息被发现
   - 下载任务出现
   - 视频库出现一条未观看视频
   - 原文消息未被标记已读

### 验证链接的限制

douyin-im 的二次验证页只监听本机回环地址。远程通过 Cloudflare 打开管理后台时，验证链接本身无法从手机直接访问。可选方案：

- SSH 端口转发到运行服务的 Mac mini；
- 在 Mac mini 本机浏览器打开；
- 或在可信网络中临时转发该验证端口（不推荐把验证页直接暴露公网）。

## 8. 下载 API（可选）

推荐独立部署 `Evil0ctal/Douyin_TikTok_Download_API`，由主服务调用：

- v5：`POST /api/v1/parse` + `GET /api/v1/tasks/:id`，支持 API Key。
- v4：`GET /api/hybrid/video_data?url=...`。
- 主服务只取解析出的媒体 URL，下载字节仍由主服务完成，最终文件也在 `data/media`。

配置：

```dotenv
DTK_BASE_URL=http://127.0.0.1:8000
DTK_API_KEY=dtk_xxx
DTK_MODE=auto
```

未配置时，共享作品主要依赖消息内直链；直链过期后会先由已连接的 `douyin-im` 会话重新解析，仍不可用时才依赖下载 API 或 yt-dlp。不要把 v5 的 PostgreSQL/Redis 作为本项目的必选依赖。

## 9. 备份与恢复

### 每日自动备份

服务每天在本地时间 04:00 后首次调度时执行 SQLite 在线备份，保留最近 7 份，存放于 `data/backups/`，权限 `0600`。

### 手动备份

```bash
pnpm backup
```

### 备份范围

| 内容 | 是否备份 |
|---|---|
| SQLite 业务数据库 | 是（每日） |
| 视频文件 | 否（建议单独做 Time Machine / rsync） |
| 封面 | 否（可再生成） |
| 临时下载 | 否 |
| 抖音 Session | 否（默认不导出） |
| 管理员密码哈希 | 包含在数据库备份中 |
| 群聊元数据 | 包含在数据库备份中 |

备份包含敏感元数据，请存放在受保护位置。恢复步骤：

```bash
bash scripts/stop.sh
cp data/db/vault.sqlite data/db/vault.sqlite.before-restore
cp data/backups/vault-YYYY...sqlite data/db/vault.sqlite
chmod 600 data/db/vault.sqlite
pnpm db:migrate
bash scripts/start.sh
```

如果媒体文件缺失，启动后健康检查会标记 `FILE_MISSING`，不会伪装成缓存成功。

## 10. 升级

```bash
bash scripts/upgrade.sh
```

脚本执行：

1. 备份数据库
2. `pnpm install --frozen-lockfile`
3. 构建前端与服务端
4. 应用数据库迁移
5. 健康检查
6. 重启 LaunchAgent

升级第三方 IM/下载适配器前：

- 先备份并阅读变更
- 重新验证登录、收消息、历史补拉
- 重新做一次实际下载与播放
- 不要自动升级不稳定的抖音协议实现

## 11. 资源与容量

| 项目 | 建议 |
|---|---|
| CPU | 低负载；下载校验/封面生成时短时升高 |
| 内存 | 预留约 1 GB |
| 磁盘 | 首期 20 GB 缓存 + 2 GB 安全预留 |
| 并发下载 | 2 |
| Web 用户 | 1 |
| 群数量 | 1–10 |
| 额外云服务器 | 不需要 |
| AI Token | 不需要 |

如果单视频平均 20 MB、每天缓存 50 个，约每天增加 1 GB。保留期与容量上限需要从第一天开启。

## 12. Docker（可选，不推荐作为首选）

仓库提供 `Dockerfile` 与 `docker-compose.yml`，但：

- 原生启动更适合需要本地 Session、设备环境与 Playwright profile 的场景。
- Docker 镜像默认包含 ffmpeg 与 yt-dlp，不包含 Playwright 浏览器。
- 映射 `./data:/data`，端口只发布到 `127.0.0.1`。
- 该路径尚未在本项目验收矩阵中完成真实账号验证。

```bash
docker compose up -d --build
docker compose logs -f
```

生产使用 Docker 前，请自行完成与原生部署相同的 Phase 0 验收。

## 13. 日常巡检

```bash
pnpm healthcheck
VAULT_ADMIN_PASSWORD='...' pnpm healthcheck   # 带详细系统状态
launchctl print gui/$(id -u)/local.douyinvault | head -30
tail -f data/logs/launchd.err.log
```

每周检查：

- 账号状态是否仍为「监听中」
- 每个已启用群最近成功同步是否更新
- 下载失败数量及错误类型
- 存储占用、容量上限、磁盘剩余
- 最近一次备份时间与大小
- 是否有 `FILE_MISSING` 或 `gap` 标记
