# 故障排查

## 1. 先看哪里

1. 仪表盘右上角状态与「健康提示」
2. 群聊页面的最近同步/错误/历史缺口
3. 下载页面的状态、尝试次数、错误码
4. `data/logs/launchd.err.log`（launchd）或终端日志
5. `pnpm healthcheck`
6. `VAULT_ADMIN_PASSWORD='...' pnpm healthcheck` 获取详细状态

不要在公开 Issue 中粘贴 Cookie、二维码、验证链接、完整签名媒体地址、群 ID 或未经脱敏的日志。

## 2. 启动与登录

### 页面提示 SETUP_REQUIRED

首次运行还没有管理员密码。

```bash
pnpm setup-token
```

使用输出的一次性令牌打开页面设置密码。若令牌文件不存在：

1. 确认 `DATA_DIR` 指向正确目录；
2. 启动一次服务以生成令牌；
3. 检查 `data/sessions/setup-token.txt` 权限是否为 0600。

### 登录后立刻又回到登录页

常见原因：

- 通过 `http://` 访问但 Cookie 被浏览器当作 Secure（仅 HTTPS 发送）。
- 反向代理没有正确传递 `X-Forwarded-Proto`。
- `PUBLIC_ORIGIN` 与浏览器实际 Origin 不一致。
- 系统时间错误导致 Cookie 立即过期。
- 浏览器阻止第三方/跨站 Cookie。

处理：

```bash
# 本机 HTTP 调试
SECURE_COOKIES=false pnpm dev

# Tunnel/HTTPS 访问
PUBLIC_ORIGIN=https://vault.example.com
```

确认 Cloudflare 传递 HTTPS。用浏览器开发者工具查看 `/api/v1/session` 的 Set-Cookie 与后续请求 Cookie。

### 忘记管理员密码

在运行服务的机器上：

```bash
VAULT_RESET_PASSWORD=1 VAULT_NEW_PASSWORD='new-long-password' pnpm reset-password
```

需要重启服务。执行后所有管理会话失效。

### 登录尝试过多（429）

等待 5 分钟。限流是进程内计数，重启服务也会清零。

## 3. 抖音连接

### 扫码后无反应 / 没有二维码

- 确认 `IM_ADAPTER=douyin-im`，`DEMO_MODE=false`。
- 检查 `douyin-im` 是否安装：`pnpm why douyin-im`。
- 查看服务日志中的登录错误，但不要粘贴 Cookie。
- 用 `douyin-im` 自带 demo 在独立目录验证同一账号。
- 如果显示 `VERIFY_REQUIRED`，按页面提示完成官方验证；系统不会绕过。

### 二次验证链接打不开

验证页只监听运行服务机器的回环地址。远程访问时：

```bash
# 在本地电脑执行，假设服务在 Mac mini 的 18760 和验证端口 XXXX
ssh -L XXXX:127.0.0.1:XXXX user@mac-mini
```

然后在 Mac mini 本机浏览器或转发后的地址打开。不要将验证端口映射到公网。

### 连接成功但没有任何消息

按顺序排除：

1. 群聊页面是否启用了目标群？默认全部关闭。
2. 群是否显示「监听正常」？账号未连接时群会暂停。
3. 「最近成功同步」是否更新？
4. 目标消息是否是普通文本/图片？这些不会创建视频任务。
5. 群消息卡片是否是图集、直播、私密作品？这些明确不支持。
6. 运行 `pnpm live:preflight` 和在 SDK demo 中确认该群事件。

**长时间没有新消息不等于监听失败。** 只有连接/同步/接口检查失败才应判为异常。

### 群列表为空

- 账号刚上线，联系人仍在加载；等几秒后点「刷新群列表」。
- 账号没有任何群。
- SDK 群列表接口失败；查看群聊页错误。
- 不要在未验证 SDK 的情况下手动改数据库。

### 新加入的群没有缓存

这是设计行为。所有新群默认关闭，必须手动启用。

## 4. 下载失败

### 下载器调用顺序与重试

单次任务按以下顺序尝试：

1. 有内存直链时先交给 Direct；没有直链时，先通过主 IM 会话（`douyin-im`）按作品 ID + 来源群重新解析。
2. 然后按 Direct → 下载 API（配置 `DTK_BASE_URL` 时）→ yt-dlp 的顺序尝试。
3. 每个适配器在同一个任务内只尝试一次，解析和下载错误都会保留；全部失败才结束任务。

只有 `NETWORK`、`TIMEOUT`、`HTTP_ERROR`、`RATE_LIMITED` 等可重试错误会进入 `RETRY_WAIT`。403、需要 Cookie、重定向域名不在白名单等资源/配置错误不会自动重试。点击「重试」会重新执行整个链路；Direct 失败后该视频的内存直链会被清除，下一次会重新向 IM 会话获取，而不是重复使用旧地址。

### 错误码速查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `UNRESOLVED` | 没有作品 ID / 直链，或无法解析 | 检查消息卡片；配置下载 API |
| `RESOURCE_UNAVAILABLE` | 作品删除、私密、403、需 Cookie | 无法自动恢复；保留失败记录 |
| `AUTH_REQUIRED` | 下载 API 凭据失败 / 抖音验证 | 检查 API Key；重新登录抖音 |
| `RATE_LIMITED` | 下载 API 限流 | 降低频率/并发，稍后重试 |
| `NETWORK` | 网络中断、连接重置 | 自动重试，可续传 |
| `TIMEOUT` | 超过单任务超时 | 增加超时或稍后重试 |
| `HTTP_ERROR` | 媒体/API 返回非 2xx | 检查错误详情与第三方服务 |
| `INVALID_MEDIA` | HTML/JSON 冒充媒体、无视频轨 | 换下载器；检查直链 |
| `FFPROBE_FAILED` | ffprobe 无法解析 | 检查媒体完整性与 ffmpeg 安装 |
| `FILE_MISSING` | 数据库有记录但文件被删 | 从备份/重新下载恢复 |
| `DISK_FULL` | 磁盘/容量暂停 | 清理或扩容 |
| `CONFIG` | yt-dlp/ffprobe 未安装或路径错误 | 修正 `.env` |

### yt-dlp 报 “Fresh cookies (not necessarily logged in) are needed”

Worker 会先通过主 IM 适配器（`douyin-im`）的已登录会话，按作品 ID + 来源群重新获取授权直链；只有该步骤没有拿到直链时，才会落到 yt-dlp，并出现这个提示。本项目不会共享或导出 douyin-im Session 给 yt-dlp。

如果日志中同一任务已经出现 `已通过主 IM 适配器获取媒体直链`，说明账号连接和 IM 解析都成功了；请继续查看该任务的 `下载适配器失败` 日志，真正原因通常是 Direct 下载失败（例如重定向域名不在白名单）。当前版本会优先把 Direct 的具体失败作为最终错误，不会再被 yt-dlp 的 Cookie 提示覆盖。

处理顺序：

1. 在群聊页确认抖音账号仍是「已连接」，并确认来源群仍启用；
2. 查看作品详情或原作品页，确认作品不是私密、已删除，且不是仅音频/图集；
3. 查看 `下载适配器失败` 日志，确认 Direct 的具体错误；
4. 对历史失败任务点击「重试」或「重试失败任务」，Worker 会重新尝试 IM 直链；
5. 仍失败时配置独立下载 API；
6. 或接受该作品失败并保留记录，不要无限重试。

### 给 yt-dlp 配置浏览器 Cookie

`douyin-im` 的桌面 IM 会话不能直接给 yt-dlp 使用（缺少网页端 `Uifid` / `s_v_web_id` / 签名参数）。如果确实要尝试 yt-dlp，需要单独从浏览器导出：

1. 在 Chrome / Edge / Firefox 中打开 `https://www.douyin.com/`，确认已登录或至少能正常浏览；
2. 用 Cookie 导出扩展（Chrome 可用 `Get cookies.txt LOCALLY`，Firefox 可用 `Export Cookies`）导出 Netscape 格式的 `cookies.txt`；
3. 保存到本机，例如 `data/yt-dlp-cookies.txt`，并限制权限：

   ```bash
   chmod 600 data/yt-dlp-cookies.txt
   ```

4. 在 `.env` 中设置：

   ```dotenv
   YTDLP_COOKIES_PATH=./data/yt-dlp-cookies.txt
   ```

5. 重启服务，设置页会显示「yt-dlp Cookie：已配置」；
6. 重新下载仍失败时，说明 yt-dlp 的抖音提取器没有通过网页反爬校验，继续使用 `douyin-im` 直链或配置下载 API。

不要把 Cookie 内容贴到聊天、Issue 或日志里，也不要把 `YTDLP_COOKIES_PATH` 指向 `data/sessions/douyin-im/accounts/*/account.json`。

### 重定向目标不在允许的域名范围内

抖音 CDN 可能把直链重定向到新的子域。日志中的错误会给出被拦截的主机名。确认该域名确实属于抖音 CDN 后，在 `.env` 中把它加入白名单并重启：

```dotenv
MEDIA_ALLOWED_HOSTS=cdn.example.com
```

多个域名用逗号分隔。不要把未知域名或任意公网域名加入白名单。

### 下载 API 不可用

- 检查 `DTK_BASE_URL` 是否指向正在运行的实例；
- v5 需要 API Key，检查 `DTK_API_KEY`；
- 检查 `/api/v1/tasks/:id` 语义与鉴权；
- 如果用 v4，尝试 `DTK_MODE=v4`；
- 确认主服务能访问该地址且不是 HTTPS 证书错误。

主服务会自己下载解析后的媒体字节，所以最终文件仍然在 `data/media`。

### 进度卡住 / 一直“下载中”

- 查看任务是否超过 `timeout_seconds`。
- 查看 `data/temp/job-*.part` 是否在增长。
- 若服务被强杀，重新启动后会恢复/重排。
- 若连续多次网络错误，等待 `next_retry_at`。
- 手动重试会把尝试次数重置为 0。

### 下载成功但播放失败

- 运行 `ffprobe <file>` 检查文件。
- 浏览器是否支持该编码（尤其 H.265/HEVC）。
- 查看 `/api/v1/videos/:id/stream` 是否返回 200/206。
- 如果封面正常但视频失败，可能是文件被外部移动；查看是否 `FILE_MISSING`。
- 重新下载前先确认原作品仍可访问。

## 5. 存储与清理

### 容量超限，下载暂停

系统不会强制删除收藏或未到期视频。处理：

1. 视频库删除不需要的内容；
2. 调低保留天数；
3. 提高容量上限；
4. 执行「立即清理」；
5. 确保磁盘剩余高于安全预留。

### 磁盘剩余低于安全预留

即使容量上限未满，也会暂停下载。清理 `data/temp`、扩大磁盘或调低安全预留（不建议低于 1 GB）。

### 下次清理时间显示不对

清理时间是运行服务的 Mac 本地时区。空库时首次清理可能只写一条汇总日志。

### “媒体文件缺失”

数据库记录存在但文件不在预期路径。通常是外部移动、恢复备份未恢复媒体、或磁盘故障。

- 从视频库删除该记录并重新下载；
- 或从备份恢复 `data/media`；
- 系统会保持失败状态，不会伪装成可播放。

## 6. 数据库与备份

### database is locked

- 确保只有一个主服务进程在写同一个 `data/db/vault.sqlite`。
- 不要同时运行 `demo:seed`、清理脚本和线上服务。
- 检查是否有另一个 launchd/手动进程。

```bash
ps aux | grep "apps/server" | grep -v grep
launchctl print gui/$(id -u)/local.douyinvault | head -20
```

### 备份文件在哪

`data/backups/vault-*.sqlite`，最近 7 份。手动：

```bash
pnpm backup
```

备份包含消息元数据和管理员密码哈希，按敏感文件保护。

### 恢复后视频都不能播放

数据库恢复了，但媒体文件没恢复。系统会标记 `FILE_MISSING`。需要单独恢复 `data/media`。

### 迁移失败

先备份数据库。查看 `pnpm db:migrate` 的错误。不要手动删除 `schema_migrations` 行来“跳过”迁移。

## 7. Web / 网络

### 页面 404 或空白

- 是否执行过 `pnpm build`？开发模式应访问 Vite `:5173`，不是 API 端口。
- 生产检查 `apps/web/dist/index.html` 是否存在。
- `WEB_DIST` 环境变量是否指向正确目录。

### SSE 一直“重连中”

- 反向代理是否缓冲了 `text/event-stream`？需要关闭 buffering。
- Cloudflare 一般支持 SSE；确认没有中间代理超时。
- 未登录时 EventSource 会 401，页面会跳回登录。
- 打开浏览器 Network 查看 `/api/v1/events` 状态码。

SSE 断线不会丢业务状态；重新连接后页面会重新拉取完整快照。

### Cloudflare 502 / 1033

- `cloudflared` 是否在运行；
- Tunnel ingress 是否指向 `http://127.0.0.1:18760`；
- 本机 `curl http://127.0.0.1:18760/healthz` 是否正常；
- Mac 是否休眠。可考虑 `caffeinate` 或系统能源设置；
- Cloudflare Access 应用是否配置正确。

### 手机端布局问题

- 确认使用最新构建；
- 清除浏览器缓存；
- 视频库/仪表盘在窄屏使用 2 列卡片，若系统字体缩放过大可能溢出，请反馈截图与浏览器版本。

## 8. 日志与诊断包

安全收集：

```bash
pnpm healthcheck
VAULT_ADMIN_PASSWORD='...' pnpm healthcheck
tail -n 200 data/logs/launchd.err.log
```

分享前必须删除：

- Cookie / Authorization / API Key
- 二维码图片 / 验证 URL
- 完整签名媒体 URL
- 群 ID、群名、昵称（如属敏感）
- 视频文件、封面、数据库备份

`docs/acceptance-report.local.md` 也包含群信息，不要提交。

## 9. 升级后异常

```bash
bash scripts/stop.sh
pnpm backup
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm healthcheck
bash scripts/start.sh
```

第三方 IM SDK 升级后必须重新验证登录、收消息、历史补拉。下载器升级后必须做一次实际下载 + 播放。若 Phase 0 重新失败，回滚到上一个已验证版本。
