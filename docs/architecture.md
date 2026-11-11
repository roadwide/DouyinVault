# 架构设计

## 1. 设计目标

Douyin Vault 是一个单用户、单账号、单机常驻的视频归档工具。架构优先保证：

1. **无感运行**：登录一次后，实时监听已启用群聊，不要求保持聊天窗口打开。
2. **保存优先**：收到视频分享后先落任务再下载，尽快在作品失效前完成缓存。
3. **本地优先**：SQLite、媒体文件、抖音 Session 全部留在本机。
4. **失败可见**：解析、下载、同步、磁盘、登录等故障都不会被静默吞掉。
5. **可替换**：IM 接入和下载器都是适配器，业务层只依赖内部标准接口。
6. **可验证**：核心逻辑有单元/集成测试，真实账号另有显式开启的现场 harness。

明确不做：微服务、Redis、云数据库、AI 内容理解、自动回复、批量爬取作者主页、绕过平台访问控制。

## 2. 部署拓扑

```
┌──────────────────────────── Mac mini ────────────────────────────┐
│                                                                  │
│  launchd / 手动进程                                               │
│    └─ Node.js 22+                                                 │
│        ├─ Fastify API + SSE + React 静态资源                       │
│        ├─ IM adapter（douyin-im / mock / Playwright）              │
│        ├─ Download worker（Direct / Douyin API / yt-dlp）          │
│        ├─ Cleanup scheduler + backup                               │
│        └─ Health checks                                            │
│                                                                  │
│  data/                                                            │
│    ├─ db/vault.sqlite                                             │
│    ├─ sessions/（抖音 Session，0700）                              │
│    ├─ media/videos + covers                                       │
│    ├─ temp/                                                       │
│    ├─ logs/                                                       │
│    └─ backups/                                                    │
└───────────────────────────────┬──────────────────────────────────┘
                                │ 127.0.0.1:18760
                     Cloudflare Tunnel
                                │
                     Cloudflare Access
                                │
                  iPhone / Mac / 平板浏览器
                     https://vault.example.com
```

- 服务默认只绑定回环地址。
- 公网 HTTPS、身份访问控制由 Cloudflare Access 提供。
- 应用自身仍有独立的管理员密码、会话 Cookie 与 CSRF 校验。
- 媒体文件不通过静态目录暴露，只经带认证的视频流接口读取。

## 3. 模块与目录

| 模块 | 位置 | 职责 |
|---|---|---|
| `AuthService` | `apps/server/src/auth` | 抖音登录、Session 状态、扫码挑战、账号记录 |
| `GroupService` | `apps/server/src/groups` | 群列表、启用开关、同步游标、缺口记录 |
| `GroupSyncService` | `apps/server/src/groups/sync-service.ts` | 实时连接后的补拉、低频历史核对、同步审计 |
| `MessageIngestService` | `apps/server/src/messages` | 消息过滤、去重、视频/来源/任务事务 |
| `ContentResolver` | `packages/core/src/douyin.ts` | 卡片/URL/作品 ID 识别，纯函数 |
| `DownloadWorker` | `apps/server/src/downloads` | 队列领取、租约、适配器编排、重试、恢复 |
| `MediaLibraryService` | `apps/server/src/media` | 视频查询、进度、收藏、Range 流、两阶段删除 |
| `CleanupService` | `apps/server/src/cleanup` | 保留期、容量、临时文件、孤儿、审计 |
| `HealthService` | `apps/server/src/health` | 账号/群/队列/磁盘/数据库健康聚合 |
| `AdminAuthService` | `apps/server/src/auth/admin-auth.ts` | 管理员密码、会话 Cookie、CSRF、限流 |
| `ApiServer` | `apps/server/src/api` | REST、SSE、静态 SPA、安全响应头 |
| Web | `apps/web` | React 仪表盘、视频库、详情、群聊、下载、设置 |
| IM adapters | `packages/im-adapters` | 平台消息 → `NormalizedMessage` |
| Download adapters | `packages/downloader-adapters` | 解析媒体地址/字节下载 |
| DB | `packages/db` | Drizzle schema、SQL 迁移、行类型 |

`packages/core` 不引用任何抖音 SDK、Fastify 或 React。消息适配与下载适配器只能依赖内部接口与共享工具。

## 4. 消息接入

### 4.1 主备路径

| 路径 | 实现 | 状态 |
|---|---|---|
| A | `douyin-im@1.1.0`，Node HTTP/WebSocket | 首选，代码已接，真实账号待验收 |
| B | Playwright 持久化浏览器资料，轮询聊天 DOM | 实验性备用，无历史补拉 |
| Demo | Mock adapter | 离线开发与自动化测试，不代表真实链路 |

官方开放平台群消息 Webhook 只覆盖粉丝群且不提供分享视频 URL，因此不作为普通好友群方案。

### 4.2 统一消息

所有适配器把平台事件映射为：

```ts
type NormalizedMessage = {
  accountId: string;
  groupId: string;          // 平台群 ID，字符串
  messageId: string;        // 平台消息 ID，字符串
  senderId?: string;
  senderName?: string;
  sentAt: number;           // 毫秒
  receivedAt: number;
  type: "shared_work" | "chat_video" | "text_with_url" | "image" | "unknown";
  workId?: string;
  shareUrl?: string;
  mediaUrl?: string;        // 仅授权直链，内存传递
  title?: string;
  coverUrl?: string;
  authorName?: string;
  source: "realtime" | "history";
  diagnostic?: string;
};
```

关键约束：

- 平台 ID 永远用十进制字符串，避免 JavaScript 安全整数精度损失。
- 不依赖群名、昵称或标题做唯一键。
- 普通文本和图片只更新“最近消息时间”，不写入内容表。
- 无法解析的视频卡片保留 `UNRESOLVED` 元数据，不伪造视频记录。
- 不调用主动已读接口。

### 4.3 实时与补拉

`MessageSource` 接口统一了 `connect / disconnect / listGroups / subscribe / syncHistory / getStatus`。

连接建立后：

1. 先订阅实时消息并持久化，避免补拉期间遗漏。
2. 同步群列表；新群默认关闭，不自动启用。
3. 对已启用群按上次同步时间补拉。`douyin-im` 适配器额外重叠 2 分钟，依靠消息唯一键去重。
4. 每次同步写入 `sync_runs`，包含发现数、新增数、游标、`gap` 与原因。
5. 达到分页上限或上次游标早于平台保留窗口时，明确记录缺口，不伪装成完整。
6. 调度器每 10 分钟做一次低频核对；限流或验证失败时由适配器返回错误，群状态转为异常。

Playwright 备用适配器明确返回“历史补拉未实现”，因此会产生可见缺口记录。

## 5. 业务数据流

### 5.1 收到视频分享

```
NormalizedMessage
  → 群必须存在且 enabled=true
  → 消息唯一键 (group_id, platform_message_id)
  → 识别 workId / mediaUrl
  → videos 以 media_key 去重
  → video_shares 记录来源消息
  → download_jobs 持久化任务
  → 唤醒 Worker
```

`media_key`：

- 有作品 ID：`douyin:work:<workId>`
- 无作品 ID 的聊天视频：`douyin:message:<accountId>:<messageId>`

作品 ID 是首选去重键。多群分享同一作品只保留一个 `videos` 行，但保留多个 `video_shares` 来源。没有作品 ID 的聊天视频下载完成后还会用 SHA-256 尝试辅助合并。

### 5.2 队列语义

- 状态：`PENDING → RESOLVING → DOWNLOADING → VERIFYING → COMPLETED`
- 临时失败：`RETRY_WAIT → PENDING`
- 永久失败：`FAILED`
- 用户取消/删除：`CANCELED`
- 优先级：实时 P0、手动重试 P1、历史补拉 P2、健康修复 P3
- 默认并发 2，可配置 1–8
- 领取任务时写入 `lease_owner` 与 `lease_expires_at`
- 下载过程中每 30 秒续租，进度更新同时续租
- 进程崩溃后，过期租约或未完成状态会回到 `RETRY_WAIT`
- 任务先落库再下载；唯一约束保证同一视频只有一个任务

### 5.3 下载器顺序

1. `DirectMediaDownloader`：消息中已提供且域名在允许列表内的直链。
2. `DouyinApiDownloader`：独立运行的 Douyin_TikTok_Download_API，支持 v5 异步任务与 v4 同步响应，主服务自己下载字节并持有文件。
3. `YtDlpDownloader`：独立进程，参数数组调用，不使用 shell。

直链签名只保存在内存的 `MediaUrlCache` 中，TTL 15 分钟。服务重启或内存直链不存在时，Worker 会先通过主 IM 适配器（`douyin-im`）的已登录会话按作品 ID + 来源群重新获取授权直链：官方下载开启时使用 `download_addr`，关闭时使用同一作品的 `play_addr`；随后交给 Direct 下载器。若作品被平台过滤或会话不可用，才继续尝试下载 API 或 yt-dlp。全部失败时任务会明确失败，而不是假装成功。

### 5.4 校验与封存

1. 下载写入 `data/temp/job-<id>.part`，支持 Range 续传。
2. 检查文件大小、HTML/JSON 冒充媒体、FTYP/WebM/MPEG-TS 文件头。
3. 默认调用 ffprobe 校验视频轨道、时长、分辨率。
4. 计算 SHA-256、实际大小。
5. 原子重命名到 `data/media/videos/<id前缀>/<videoId>.<ext>`。
6. 生成或下载封面到 `data/media/covers/`。
7. 事务更新视频为 `ready`、任务为 `COMPLETED`。
8. 视频文件缺失会被一致性检查标记 `FILE_MISSING`，不会继续显示为已缓存。

HTTP 200 不等于成功；只有媒体校验通过并完成原子移动才算缓存完成。

### 5.5 源作品可访问性

对已经 `ready` 的视频，API 会按作品 ID + 最近来源群向主 IM 会话实时查询作品详情：

- 平台明确返回 `filtered` 或不再返回该作品 → `unavailable`，视频卡片显示「平台不可访问」，详情页显示提示横幅。
- 查询失败、账号未连接或适配器不支持 → `unknown`，不展示标签，避免误报。
- 结果只缓存在内存：可用 2 分钟、不可用 1 分钟、查询失败 20 秒；手动刷新和打开详情页会绕过缓存。
- 不写入数据库。平台恢复访问后，下一次查询会自动去掉标签。

## 6. 数据库

SQLite 开启 WAL、外键、busy timeout，并维护 `schema_migrations`。业务库独立于 douyin-im 自己的本地状态库。

主要表：

| 表 | 作用 | 关键约束 |
|---|---|---|
| `accounts` | 抖音账号与连接状态 | `(platform, platform_uid)` 唯一 |
| `groups` | 群配置与游标 | `(account_id, platform_group_id)` 唯一 |
| `messages` | 视频分享消息与诊断 | `(group_id, platform_message_id)` 唯一 |
| `videos` | 作品/聊天视频实体 | `media_key` 唯一、`(platform, work_id)` 部分唯一 |
| `video_shares` | 视频来源 | `(video_id, message_id)`、`message_id` 唯一 |
| `download_jobs` | 持久化任务 | `video_id` 唯一 |
| `video_progress` | 观看进度 | `video_id` 主键 |
| `settings` | 设置与内部状态 | `key` 主键 |
| `cleanup_logs` | 清理审计 | 删除后保留 `video_ref` |
| `sync_runs` | 补拉审计与缺口 | 群 + 开始时间索引 |
| `admin_sessions` | 管理会话 | 只存 Cookie SHA-256 |

视频的收藏、观看状态没有硬编码进同一个“用户”概念：收藏当前在 `videos`，观看状态在 `video_progress`，为未来多用户留出扩展空间。MVP 仍只支持单管理员/单账号。

## 7. 删除与清理

### 7.1 删除

用户删除采用两阶段：

1. 标记 `videos.status = deleting`，取消任务，阻止播放。
2. 删除媒体与封面文件；失败则恢复原状态并报错。
3. 事务删除视频记录（级联来源、任务、进度），写 `cleanup_logs` 审计。
4. 重复删除返回“未删除任何东西”，保持幂等。

共享视频的来源变化不会自动删除唯一媒体文件。

### 7.2 保留策略

| 分类 | 默认 |
|---|---|
| 未观看 | 下载后 30 天 |
| 已观看 | 标记已观看后 7 天 |
| 收藏 | 永不自动删除 |
| 失败记录 | 7 天 |
| 临时文件 | 24 小时 |
| 孤儿文件 | 确认无引用且超过 1 小时 |

观看判定：播放位置达到时长 80%。仅打开详情页或封面不算观看。

### 7.3 容量

默认软配额 20 GB，磁盘安全预留 2 GB。

1. 先删过期临时文件和无引用文件。
2. 再删已过期的已观看视频。
3. 再删已过期的未观看视频。
4. 仍未低于上限时，**暂停新增下载**，不强制删除收藏、未到期视频或未观看保护内容。

磁盘剩余空间低于安全预留的优先级高于容量配额。

## 8. Web/API

- 统一前缀 `/api/v1`
- JSON API + SSE（`/api/v1/events`）
- 视频流支持单段 HTTP Range、`206`、`416`、`HEAD`、ETag
- 删除、重试、设置更新要求管理员会话 + CSRF Header；Origin 校验阻止跨站表单
- SSE 断线由前端重连；重连后页面重新拉取完整状态，不只依赖增量
- 静态前端不包含业务数据；媒体目录从不直接暴露

主要接口与产品页面的对应关系见 `docs/implementation.md`。

## 9. 可靠性与故障分类

| 场景 | 自动处理 | 用户可见 |
|---|---|---|
| 临时断网 | SDK 重连 / 任务延迟重试 | 重连中、等待重试 |
| WebSocket 断开 | 重建并补拉 | 同步中 / 历史缺口 |
| 登录失效 | 暂停监听，要求重新登录 | 需要登录 |
| 视频解析失败 | 尝试 API / yt-dlp | 解析失败、错误码 |
| 作品不可访问 | 停止无效重试 | 资源不可访问 |
| 下载超时 | 有限重试，保留 .part | 等待重试 |
| 进程崩溃 | 恢复租约与队列；清理/续传临时文件 | 恢复中 |
| 磁盘不足 | 暂停下载、清理临时文件 | 空间不足 |
| 文件被外部删除 | 一致性检查标记失败 | 媒体文件缺失 |
| 单群失败 | 隔离该群 | 群聊异常 |
| SQLite 异常 | 停止消费、健康告警 | 数据库异常 |

健康检查每分钟运行：进程、数据库、ffprobe、文件系统、Worker、IM 状态、最近成功同步、队列深度、24 小时指标。**没有新消息不算故障**；只有连接/同步/接口探测失败才判为接入异常。

## 10. 关键取舍

- **SQLite 自研队列而非 Redis**：单用户、低并发，事务与崩溃恢复足够，部署简单。
- **主服务拥有最终文件**：外部下载 API 可以解析，但字节由主服务写入自己的临时文件，避免两份无法统一清理的媒体。
- **不持久化签名媒体 URL**：接受“重启后直链失效”的代价，换取日志/备份/API 不泄漏签名。作品 ID 仍可由主 IM 会话重新解析，或走备用解析。
- **Playwright 不冒充完整方案**：不实现历史补拉，缺口可见。
- **新群默认关闭**：用户必须主动授权，避免无意缓存。
- **群名不作为键**：只使用稳定群 ID。
- **不主动已读**：本地观看状态与抖音消息已读完全分离。
