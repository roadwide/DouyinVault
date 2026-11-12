# 实现说明

本文记录已落地代码的关键设计、边界与验证方式。产品目标与架构见 [architecture.md](architecture.md)。

## 1. 运行时与目录

### 1.1 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js 22.13+（开发机为 Node 25，构建目标 Node 22） |
| 语言 | TypeScript ESM |
| 包管理 | pnpm workspace |
| API | Fastify 5 + Zod 4 |
| Web | React 19 + React Router 7 + Vite 7 + Tailwind CSS 4 |
| 数据库 | SQLite + better-sqlite3 + Drizzle ORM |
| 队列 | `download_jobs` 表 + 进程内 Worker |
| 媒体 | ffmpeg / ffprobe |
| 日志 | Pino |
| 测试 | Vitest + Playwright |

没有 Redis、PostgreSQL、消息中间件或云服务依赖。Docker 仅作可选发行方式。

### 1.2 代码结构

```
apps/
  server/src/
    main.ts              启动、信号处理、优雅关闭
    context.ts           依赖装配（唯一装配点）
    config.ts            环境变量→AppConfig
    api/                 Fastify、认证 Hook、路由、SSE、Range
    auth/                管理员会话 + 抖音账号服务
    groups/              群列表、同步审计
    messages/            消息标准化后的持久化与去重
    downloads/           队列 Worker、租约、恢复、下载编排
    media/               视频库查询、进度、流、删除
    cleanup/             保留期/容量/临时/孤儿
    health/              系统快照与健康问题
    backup/              SQLite 在线备份
    scheduler.ts         定时清理、备份、补拉、健康推送
  web/src/
    api/                 类型化 fetch + CSRF
    components/          设计系统、布局、播放器外框
    pages/               仪表盘/视频库/详情/群聊/下载/设置
    hooks/               管理会话、SSE 事件分发
packages/
  core/                  纯领域逻辑
  db/                    schema + 迁移
  im-adapters/           mock / douyin-im / Playwright
  downloader-adapters/   direct / Douyin API / yt-dlp
  shared/                时间、字节、路径、URL 脱敏等
scripts/                 安装、部署、测试、运维
tests/
  unit/ integration/ fixtures/ e2e/
docs/
```

`context.ts` 是依赖装配中心。模块之间通过构造参数注入服务，不直接互相 import 内部实现。

## 2. 配置加载

启动顺序：

1. `loadDotEnv()` 读取工作目录 `.env`（不存在则忽略）。
2. `loadConfig()` 用 Zod 校验环境变量并转成强类型 `AppConfig`。
3. `buildPaths()` 计算所有本地目录。
4. `ensureDataScaffold()` 创建 `0700` 目录。
5. 打开 SQLite、执行迁移、初始化管理员认证。
6. 装配 IM、消息、队列、清理、健康服务。

关键环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 必须保持回环，除非已有外层防护 |
| `PORT` | `18760` | HTTP 端口 |
| `DATA_DIR` | `./data` | 全部本地状态根目录 |
| `PUBLIC_ORIGIN` | 无 | CSRF Origin 白名单，一般填 `https://vault.example.com` |
| `ADMIN_PASSWORD` | 无 | 首次初始化管理员密码；不填则生成一次性令牌 |
| `IM_ADAPTER` | `mock` | `mock` / `douyin-im` / `playwright` |
| `DEMO_MODE` | `false` | 开启模拟扫码与演示接口；生产应关闭 |
| `DTK_BASE_URL` | 无 | 独立 Douyin_TikTok_Download_API |
| `DTK_API_KEY` | 无 | v5 API Key；不会返回前端 |
| `DTK_MODE` | `auto` | `auto` / `v5` / `v4` |
| `YTDLP_PATH` | `yt-dlp` | 备用下载器 |
| `FFPROBE_PATH` | `ffprobe` | 媒体校验 |
| `SECURE_COOKIES` | 自动 | 仅在 HTTPS 请求上设置 Secure Cookie |

`SECURE_COOKIES` 的实际行为：配置为真且当前请求经 HTTPS（含 `X-Forwarded-Proto: https`）时，管理 Cookie 才带 `Secure`。因此同一实例可同时支持本机 HTTP 调试与 Tunnel 的 HTTPS 访问。

## 3. 状态机

### 3.1 账号

```
UNCONFIGURED → LOGIN_REQUIRED → AUTHENTICATING → CONNECTED
                     ↑               │              │
                     │               ↓              ├→ DISCONNECTED → RECONNECTING → CONNECTED
                     └── LOGGED_OUT ←┴──────────────┴→ VERIFY_REQUIRED → AUTHENTICATING
```

- `LOGGED_OUT` 只由用户主动退出触发。
- `VERIFY_REQUIRED` 表示平台要求官方二次验证，系统不绕过。
- 账号非连接状态时，已启用群的状态会转为 `paused`，避免 UI 显示“监听正常”。
- `last_connected_at`、`last_message_at`、`last_successful_sync_at` 分开记录。服务进程存活不用于判断监听健康。

### 3.2 下载任务

```
PENDING → RESOLVING → DOWNLOADING → VERIFYING → COMPLETED
   ↑          │            │            │
   │          └────────────┴────────────┴→ RETRY_WAIT（有限次）
   │                                        │
   └────────────────────────────────────────┘
                              永久错误 → FAILED
                              删除/取消 → CANCELED
```

任务行先创建，再唤醒 Worker。任务完成前不会进入可播放状态。

## 4. 消息写入事务

`MessageIngestService.ingestSync` 在一次 SQLite 事务内完成：

1. 群必须存在；不存在的群以 `enabled=false` 创建，最多更新活动时间。
2. 未启用群直接返回 `ignored`，不保存文本。
3. 非视频消息返回 `ignored`；无法解析的视频卡片保存为 `unresolved`。
4. `messages` 使用 `(group_id, platform_message_id)` 唯一约束防止重连/补拉重复。
5. `videos` 按 `media_key`（优先作品 ID）复用。
6. 重复分享只新增 `video_shares`，不新增视频/任务。
7. 首次发现创建 `download_jobs`；若旧记录已永久失败，新的分享会把它重置为 `PENDING`。
8. 事务外写入内存 `MediaUrlCache`，发出 `message.detected` 并唤醒 Worker。

因此“同一作品重复分享”和“同一消息重复到达”在数据库层有不同处理：前者新增来源，后者直接判定为重复消息。

## 5. 下载 Worker

### 5.1 领取

`tick()` 每秒运行：

1. 读取最新设置。
2. 检查自动下载开关、磁盘安全预留、容量上限。
3. 恢复过期租约。
4. 按 `priority ASC, created_at ASC` 选择可执行任务。
5. 条件更新 `status=RESOLVING` 并写入租约和 `attempts+1`。
6. 用进程内 Map 限制实际并发。

内存直链不存在时，Worker 先通过主 IM 适配器的已登录会话按作品 ID + 来源群获取新的直链；拿到后按 Direct → Douyin API → yt-dlp 顺序尝试。每个适配器的解析与下载错误都会保留；只有全部失败才结束任务。可重试错误优先于泛化的资源不可用错误；主 IM 已拿到直链时，最终错误优先采用 Direct 的具体失败原因，避免被最后兜底的 yt-dlp Cookie 提示误导。Direct 失败后会清除该视频的内存直链，下一次重试重新向 IM 会话获取。

### 5.2 续传与超时

- HTTP 下载发送 `Range: bytes=<已有长度>-`。
- 服务器返回 `206` 则追加；返回 `200` 则重新开始。
- 总大小与已接收字节不符时抛出可重试网络错误。
- 临时文件在任务失败且错误可重试时保留，供下一次续传。
- yt-dlp 使用 `--continue`，同样保留分片。
- 每 30 秒更新租约，避免长任务被误判为死任务。
- 取消/删除通过 `AbortController` 中断子进程或 HTTP 流。

### 5.3 校验

- 文件大小下限 1 KB。
- HTML/JSON 冒充媒体直接拒绝。
- MP4 (`ftyp`)、WebM、MPEG-TS 文件头识别。
- 默认 ffprobe 检查 `hasVideo`、时长、分辨率。
- SHA-256 流式计算，不把视频读入内存。
- 视频最终路径使用 ULID + 真实扩展名，写入 `videos.file_path`。
- 封面优先从视频抽帧；下载远程封面时校验图片签名。

### 5.4 崩溃恢复

启动时：

- 所有 `RESOLVING/DOWNLOADING/VERIFYING` 任务进入 `RETRY_WAIT`（`attempts` 达上限则 `FAILED`），错误码 `INTERNAL`，下一次立即重试。
- `ready` 但文件不存在 → `failed` + `FILE_MISSING`。
- `pending` 但没有任务 → 自动创建 P3 修复任务。
- 过期的 `.part` 在清理时删除，活动的任务临时文件不删。

租约保证同一视频同一时刻只有一个 Worker 实际执行。

## 6. 视频库与播放

`MediaLibraryService` 使用 SQL 聚合：

- 默认只显示 `ready/pending/failed`，不显示 `deleted/deleting`。
- 一个作品只出现一次，列表读取最近来源群/分享人。
- 搜索覆盖标题、作品 ID、作者、分享人。
- 详情返回全部来源、任务状态、错误、SHA-256。
- 观看进度独立表，播放超过阈值（默认 80%）自动标记已观看；手动修改可覆盖。
- 收藏在 `videos.is_favorite`；自动清理永不触碰收藏。
- 仅对 `ready` 视频实时查询源作品可访问性；`unavailable` 显示标签，查询失败为 `unknown` 不误报。结果只做短 TTL 内存缓存，不写数据库；手动刷新/打开详情页强制复查。

视频流：

- 先校验管理员会话。
- 只接受单段 `bytes` Range；多段或非法范围返回 `416`。
- 支持 `HEAD`、ETag、`Last-Modified`、`Cache-Control: private`。
- 通过 `createReadStream(start, end)` 输出；不使用 `@fastify/static` 映射媒体目录。
- 删除中/失败/文件缺失时返回 4xx，不提供残缺内容。

## 7. 删除与清理

`delete()` 先 `status=deleting`，取消任务，删除视频与封面；失败回滚状态。成功后在同一事务中删除视频行并写审计。消息与群记录保留，来源行随视频级联删除。

清理任务顺序：

1. 一致性检查（缺文件）。
2. 过期临时文件（避开活动任务）。
3. 过期失败记录。
4. 过期已观看 → 过期未观看。
5. 孤儿文件扫描（1 小时保护窗口）。
6. 计算容量与磁盘状态，必要时暂停 Worker。

资源保护优先级：收藏 > 未到期未观看 > 未到期已观看 > 容量。容量超限时宁可暂停下载也不强制删除受保护视频。

## 8. 管理员认证

- 密码使用 `scrypt`，每密码独立随机盐。
- 首次运行：`ADMIN_PASSWORD` 环境变量或 `data/sessions/setup-token.txt` 一次性令牌。
- 登录成功后创建 32 字节随机 Cookie，数据库只存其 SHA-256。
- Cookie：`HttpOnly`、`SameSite=Lax`、HTTPS 时 `Secure`。
- 会话默认 30 天；服务端校验过期时间并滚动更新活跃时间。
- 所有写操作要求 `X-CSRF-Token`，并校验 `Origin`。
- 登录/安装尝试限流：5 分钟 6 次。
- 控制台输出不包含令牌；安装令牌只写入 `0600` 文件。
- `pnpm reset-password` 可在本机重置密码并使全部管理会话失效。

### 8.1 API 对照

下表除标注外均省略 `/api/v1` 前缀。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/session` | 管理会话 / 是否需要首次设置 |
| POST | `/api/v1/session/setup`、`/login`、`/logout` | 管理员密码与会话 |
| GET | `/api/v1/system/status` | 仪表盘与健康快照 |
| GET | `/api/v1/system/unresolved` | 未解析卡片诊断 |
| GET | `/auth/status` | 抖音账号状态与登录挑战 |
| POST | `/auth/login`、`/auth/logout`、`/auth/demo/complete` | 抖音连接（演示接口仅 mock） |
| GET/PATCH | `/api/v1/groups`、`/groups/:id` | 群列表、启停监听 |
| POST | `/api/v1/groups/:id/sync`、`/groups/refresh` | 手动补拉、刷新群列表 |
| GET | `/api/v1/videos`、`/videos/:id` | 列表、筛选、详情 |
| GET | `/api/v1/videos/:id/stream`、`/cover` | 认证媒体流（Range）与封面 |
| PATCH | `/api/v1/videos/:id` | 收藏、观看状态 |
| POST | `/api/v1/videos/:id/progress` | 播放进度 |
| DELETE | `/api/v1/videos/:id` | 幂等删除 |
| POST | `/api/v1/videos/batch-delete` | 批量删除 |
| GET | `/api/v1/downloads` | 队列 |
| POST | `/api/v1/downloads/:id/retry` | 手动重试 |
| GET/PATCH | `/api/v1/settings` | 设置读取/校验更新 |
| POST | `/api/v1/cleanup/run`、`/backup/run` | 手动维护 |
| GET | `/api/v1/events` | SSE |

所有 `/api/v1` 业务接口默认要求管理员会话；写操作额外要求 CSRF Header 与 Origin 校验。`mock` 演示接口在生产配置中不可用。

## 9. 健康与事件

`HealthService.snapshot()` 聚合：

- 数据库与迁移
- IM 账号状态、上次连接/收消息/成功同步
- 群数量、启用数、异常数
- 视频 ready/pending/failed、未观看、收藏
- 队列 PENDING/进行中/等待重试/失败/完成
- 存储占用、容量、磁盘剩余、预留
- 24 小时发现/完成/失败
- 清理计划与上次运行
- 未解析消息数
- ffprobe 可用性
- 结构化的 `issues[]`

健康状态为 `ok / degraded / error`。任何警告都会显示在首页，避免“进程活着但停止缓存”被误认为正常。

SSE 事件：

```
system.status_changed
auth.status_changed
group.status_changed
message.detected
download.progress
download.completed
download.failed
video.deleted
cleanup.completed
```

事件只做通知，不作为唯一状态来源。前端每次页面加载与重连都会重新请求完整状态。

## 10. Web 页面

| 页面 | 数据源 | 重点 |
|---|---|---|
| 登录/首次设置 | `/session` | 密码、一次性令牌、错误反馈 |
| 仪表盘 | `/system/status`, `/videos`, `/downloads` | 监听状态、存储、最近视频、队列、健康问题 |
| 视频库 | `/videos`, `/groups` | 筛选、搜索、排序、批量删除、网格/列表 |
| 视频详情 | `/videos/:id` | 本地播放、续播、速度、收藏/已看、来源、错误、重试 |
| 群聊 | `/groups`, `/auth/status` | 逐个启用、补拉、缺口/错误、扫码连接 |
| 下载 | `/downloads` | 队列、进度、失败原因、手动重试 |
| 设置 | `/settings` | 保留期、容量、并发、清理、备份、诊断、退出 |

移动端使用底部导航；桌面端使用侧栏。所有页面通过共享 SSE 事件刷新，避免多连接。

## 11. 测试与验证

| 命令 | 覆盖 |
|---|---|
| `pnpm test` | 文本解析、域名白名单、保留策略、重试、Range、媒体 URL 提取、工具函数 |
| `pnpm test:integration` | 迁移、消息去重、下载到磁盘、SHA/文件、删除、API 鉴权/CSRF/Range/SSE、崩溃恢复、备份、设置 |
| `pnpm test:fixtures` | 录制样本驱动的回归 |
| `pnpm test:e2e` | 桌面和移动端登录、仪表盘、视频库、详情、群聊、下载、设置 |
| `pnpm test:live` | 真实账号扫二维码、群列表、作品卡、`getAccess()`、可选下载；不自动宣称通过 |

当前构建环境已执行的自动化结果：

- 51 个单元测试通过
- 4 个录制样本测试通过
- 15 个集成测试通过
- 5 个 E2E 通过（4 桌面 + 1 移动；其余按项目跳过）
- 类型检查覆盖 5 个 workspace 包、脚本、测试和 E2E

**未执行**：真实抖音账号 Phase 0。详见 [acceptance.md](acceptance.md)。

## 12. 扩展点

### 新增 IM 适配器

实现 `MessageSource`：

```ts
interface MessageSource {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listGroups(): Promise<GroupInfo[]>;
  subscribe(onMessage: (m: NormalizedMessage) => Promise<void>): Promise<void>;
  syncHistory(groupId: string, cursor?: string): Promise<HistorySyncResult>;
  getStatus(): SourceStatus;
  startLogin(): Promise<LoginChallenge>;
  logout(): Promise<void>;
}
```

不得把平台原始大整数转成 number，不得保存所有文本，无法确认的历史窗口必须返回 `gap: true`。

### 新增下载器

实现 `MediaDownloader`，并在 `DownloadWorker.buildAdapters()` 中按优先级注册。下载器不得操作业务数据库；临时文件、校验、封存、去重由 Worker 负责。

### 数据库迁移

在 `packages/db/src/migrations.ts` 追加不可变迁移项，按顺序执行。升级前先 `pnpm backup`。不要修改已发布的迁移 SQL。

## 13. 为什么没有做某些事

- **没有把完整下载 API 嵌入主服务**：v5 依赖 PostgreSQL/Redis 与身份池，适合独立部署；主服务只取出媒体 URL，自己下载与持有文件。
- **没有持久化签名直链**：避免泄漏与备份污染；代价是重启后直链任务需要备用解析器。
- **没有自动开启新群**：防止无意抓取未授权内容。
- **没有把群消息标记已读**：本地观看状态独立于抖音。
- **没有用标题/封面判重**：不可靠；使用平台作品 ID，必要时再用 SHA-256。
- **没有自动重试永久性 403/已删除**：保留失败记录，避免无限请求平台。
