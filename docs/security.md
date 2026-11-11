# 安全模型

## 1. 威胁模型

Douyin Vault 处理三类敏感信息：

1. 抖音账号 Session、设备凭据、登录二维码与二次验证链接。
2. 群聊消息元数据、群 ID、发送者昵称、视频来源。
3. 本地视频文件与观看记录。

主要威胁：

- 公网扫描发现未授权的管理接口或媒体 URL。
- Cloudflare Access 配置错误导致匿名访问。
- 恶意网页借用户浏览器发起跨站写操作。
- 日志、备份、错误响应泄漏 Cookie 或签名媒体 URL。
- 下载器被恶意链接利用做 SSRF 或任意文件写入。
- 媒体目录被静态服务器直接暴露。
- 项目被误用于抓取未授权群聊或绕过平台访问控制。

非目标：抵御已取得本机 root/用户权限的攻击者；防御抖音平台本身；多租户隔离。

## 2. 边界

```
Internet ── Cloudflare Access ── Tunnel ── 127.0.0.1:18760
                                                    │
                                       管理员会话 + CSRF + 应用认证
                                                    │
                                       SQLite / 媒体 / Session (data/)
```

- 服务默认只绑定 `127.0.0.1`。
- 数据库不监听端口。
- 媒体目录不是静态根目录。
- 前端静态资源可以匿名加载，但页面内所有业务数据都来自受保护的 API。
- 外部访问必须经 HTTPS + Cloudflare Access 或等价反向代理。

## 3. 管理员认证

### 首次初始化

两种方式：

1. `ADMIN_PASSWORD` 环境变量：启动时转为 scrypt 哈希写入数据库。之后可以移除环境变量。
2. 一次性安装令牌：保存在 `data/sessions/setup-token.txt`（`0600`），Web 设置密码后删除。

密码至少 10 个字符。没有默认密码。

### 会话

- 登录成功生成 32 字节随机 Cookie。
- 数据库只保存 Cookie 的 SHA-256，不保存原文。
- `HttpOnly`，前端 JavaScript 不可读。
- `SameSite=Lax`。
- 请求经 HTTPS 时附加 `Secure`；本机 HTTP 调试时不附加，避免本地无法登录。
- 默认 30 天过期，可配置。
- 退出会删除服务端会话并清除 Cookie。
- 所有管理会话可在重置密码时整体失效。

### 限流

- 登录/首次设置：同一 IP 5 分钟最多 6 次，失败返回 429。
- 成功登录会清空该 IP 的失败计数。
- 速率限制是进程内实现，重启后清零；足以应对单用户本地场景。

### 重置密码

需要本机文件系统访问：

```bash
VAULT_RESET_PASSWORD=1 VAULT_NEW_PASSWORD='new-long-password' pnpm reset-password
```

该操作会：

- 更新 scrypt 哈希；
- 删除全部 `admin_sessions`；
- 删除残留安装令牌。

如服务正在运行，重启以清除内存状态。

## 4. CSRF 与 Origin

所有非 GET/HEAD 的管理 API 都要求：

1. 有效管理员会话 Cookie；
2. `X-CSRF-Token`，与当前会话绑定；
3. `Origin` 在允许集合内。

允许集合：

- `PUBLIC_ORIGIN` 的 Origin；
- 当前请求的 `X-Forwarded-Proto://X-Forwarded-Host` 或 `Host`；
- 开发模式下的 `localhost:5173` / `127.0.0.1:5173`。

登录和首次设置没有会话 CSRF Token，但仍执行 Origin 校验。跨站请求无法读取 Token，因此不能构造有效写请求。

SSE 只读，使用 Cookie 认证；不要求 CSRF Header。

## 5. 响应头

应用统一设置：

```
Content-Security-Policy: default-src 'self'; img-src 'self' data:;
  media-src 'self' blob:; style-src 'self' 'unsafe-inline';
  script-src 'self'; connect-src 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
```

HTTPS 部署时建议由 Cloudflare 提供 HSTS。应用在 `SECURE_COOKIES` 且实际 HTTPS 时也会给管理 Cookie 加 Secure。

`style-src 'unsafe-inline'` 仅用于 React 内联样式；未启用 `unsafe-eval`，未加载第三方脚本。

## 6. 媒体访问

- 视频/封面接口都经过管理员会话校验。
- 使用 `createReadStream` 输出，不使用静态目录映射。
- 支持 Range 时必须严格校验：
  - 单段 `bytes=start-end`；
  - 起点必须位于文件内；
  - 非法范围返回 `416`，不返回文件内容；
  - 不允许通过路径参数访问任意文件。
- 文件路径在数据库中是相对路径，读取前用 `resolveWithin` 检查未越出媒体根目录。
- `Content-Type` 根据真实扩展名选择，并带 `nosniff`。
- `Cache-Control: private`，禁止共享缓存。

## 7. Session 与验证信息

- 抖音 Session 位于 `data/sessions/`，目录 `0700`，文件 `0600`。
- 不通过 API 返回 Cookie、Token、设备凭据或完整原始登录数据。
- 二维码只通过受认证的管理接口返回，属于一次性登录挑战；仍不应截图分享。
- 二次验证链接只监听 `127.0.0.1`，属于短期能力。不要把该端口直接暴露到公网。
- 日志不记录二维码、验证 URL、Cookie、Authorization、API Key。

## 8. 日志脱敏

- Pino 配置了字段级 redact：
  - `cookie`、`authorization`、`x-api-key`、`x-csrf-token`
  - `password`、`token`、`apiKey`
  - `qrDataUrl`、`verificationUrl`
  - `mediaUrl`、`shareUrl`、`url`
- 请求日志只保留 path，不记录 query string。
- 下载错误不会输出完整签名 URL；必要时用 `redactUrl()` 只保留 host/path。
- 群聊文本不会写入日志。

即使有脱敏，也不要把完整日志公开上传。错误对象和第三方库仍可能包含意外上下文。

## 9. SSRF 与下载器安全

### DirectMediaDownloader

- 只允许 HTTP/HTTPS。
- 只允许抖音 CDN 域名白名单与 `MEDIA_ALLOWED_HOSTS` 配置项。
- 默认禁止回环/私网地址；开发/测试可显式开启 loopback，生产关闭。
- 手动跟随重定向，最多 5 次，每跳都重新校验宿主。
- 拒绝 HTML/JSON 冒充媒体。

### DouyinApiDownloader

- 只从配置的独立 API 获取媒体 URL。
- 下载前拒绝明显私网/链路本地地址。
- 不使用 API 的“下载到它的磁盘”功能，最终文件由主服务写入自己的目录。

### YtDlpDownloader

- 参数数组调用，不使用 shell，避免命令注入。
- 只接受作品 ID / 抖音链接构造的 URL。
- 超时与取消会终止进程。
- 输出目录是受控临时目录。

## 10. 数据与备份

- `data/` 根目录建议 `0700`。
- SQLite、Session、备份文件 `0600`。
- 备份包含消息元数据与管理员密码哈希；应按敏感文件保护。
- 视频文件本身可能包含他人版权内容，不应公开分享或上传到第三方。
- 抖音 Session 默认不进入备份包，也不应提交 Git。
- GitHub CI 只运行模拟数据测试，不上传 Session、真实群聊数据或媒体。

## 11. 隐私与平台边界

- 只处理用户主动启用的群聊。
- 不保存普通文本、图片与表情内容，只更新群活动时间。
- 不调用主动已读接口，不改变用户的抖音未读状态。
- 不批量爬取作者主页，不绕过删除后的访问限制。
- 不做内容理解、自动回复、自动审批入群申请。
- 不向第三方分析服务发送群聊、视频或观看记录。

## 12. 安全部署检查清单

- [ ] `HOST=127.0.0.1`
- [ ] 公网仅通过 Cloudflare Tunnel / 受保护反代
- [ ] Cloudflare Access 仅允许指定身份
- [ ] 应用管理员密码独立且足够长
- [ ] `PUBLIC_ORIGIN` 与实际访问 Origin 一致
- [ ] 端口没有直接暴露到局域网/公网
- [ ] 本机/内部网络未登录访问系统状态、视频流均返回 401
- [ ] 公网入口未通过 Cloudflare Access 时被重定向到登录页
- [ ] `data/`、`sessions/`、`backups/` 权限正确
- [ ] `.env` 权限 `0600`，不含真实 API Key 的仓库副本
- [ ] 日志、备份、二维码、验证链接未提交 Git
- [ ] 定期检查失败任务、群同步缺口与文件缺失
- [ ] 恢复演练：仅恢复数据库而缺少媒体时，系统能标记异常
