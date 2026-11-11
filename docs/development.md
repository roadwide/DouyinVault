# 开发指南

## 1. 环境

- Node.js 22.13+（CI 模板使用 Node 22 最新版）
- pnpm 10
- ffmpeg / ffprobe（集成下载校验与 E2E 演示数据）
- 可选：yt-dlp
- 可选：Playwright Chromium（E2E）

```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:fixtures
pnpm test:e2e
```

首次开发建议使用 mock 适配器：

```dotenv
IM_ADAPTER=mock
DEMO_MODE=true
ADMIN_PASSWORD=dev-password-123
```

启动：

```bash
pnpm dev
# Web: http://127.0.0.1:5173
# API: http://127.0.0.1:18760
```

Vite 代理 `/api` 与 `/healthz` 到后端。

## 2. 代码边界

- `packages/core`：不依赖 Fastify、React、抖音 SDK；可被任何层引用。
- `packages/db`：schema、迁移、行类型；不包含业务规则。
- `packages/im-adapters`：只负责把平台事件转为 `NormalizedMessage`。
- `packages/downloader-adapters`：只负责解析直链和写字节；不访问业务数据库。
- `apps/server/src/context.ts`：唯一依赖装配点。
- `apps/web`：不直接接触 SQLite、Session 或磁盘路径。

新增模块时保持单向依赖：server → core/db/adapters → shared。

## 3. 演示数据

```bash
DATA_DIR=./data-demo ADMIN_PASSWORD=demo-password-123 \
IM_ADAPTER=mock DEMO_MODE=true pnpm demo:seed
```

脚本会：

1. 用 ffmpeg 生成 6 个垂直渐变短片；
2. 用临时本地 HTTP 服务器提供媒体；
3. 启动 mock 账号并启用两个群；
4. 通过真实入库/下载 Worker 写 6 个可播放视频；
5. 制造 1 次跨群重复分享、1 个失败记录、1 条未解析消息；
6. 标记 1 个收藏、1 个已观看（90% 进度）。

种子只允许空数据目录，避免破坏真实数据。运行期间不要同时启动另一个写同一目录的服务。

## 4. 测试策略

### 单元

```bash
pnpm test
```

覆盖：

- 作品 ID / 分享文本 / 域名白名单
- 去重键与优先级
- 观看阈值、重试延迟
- 清理计划（收藏、过期、容量）
- HTTP Range
- 下载 API 载荷提取（v4/v5）
- 路径逃逸、URL 脱敏、并发限制

### 集成

```bash
pnpm test:integration
```

每个测试使用独立临时数据目录和独立 SQLite：

- 消息去重与多群来源
- 真实下载 Worker（本地 HTTP + 伪 MP4 文件头）
- SHA/文件写入/任务完成
- 删除、过期清理、审计
- 管理员认证、CSRF、Origin、Range、SSE
- 崩溃租约恢复、文件缺失
- 备份可打开、设置校验、健康状态

集成测试将 `FFMPEG_PATH` 指向不存在的路径以跳过封面生成；媒体校验使用 `verifyWithFfprobe=false` 与伪 MP4 头部。真实 ffprobe 由 E2E 种子数据的实际下载覆盖。

### Fixture

```bash
pnpm test:fixtures
```

录制样本位于 `tests/fixtures/`。新增适配器时，先保存脱敏原始卡片/文本，再写解析回归。不要提交真实群聊数据。

### E2E

```bash
pnpm test:e2e
```

- 自动构建 Web/Server
- `scripts/e2e-server.sh` 在 `.e2e-data` 生成演示数据
- 在 `127.0.0.1:18761` 启动服务
- Playwright 桌面 + 移动 Chromium
- 不连接抖音，不上传任何真实数据

需要浏览器：

```bash
pnpm exec playwright install chromium
```

### 真实账号

```bash
pnpm live:preflight
RUN_LIVE_TESTS=1 RUN_LIVE_DATA_DIR=./data/live-check pnpm test:live
```

见 [acceptance.md](acceptance.md)。默认关闭；只在专用账号/群运行。

## 5. 添加 IM 适配器

1. 在 `packages/im-adapters/src/` 实现 `MessageSource`。
2. 所有平台 ID 字符串化。
3. 文本/图片不要存库；返回标准化类型，由 Ingest 过滤。
4. 无法确认的历史窗口返回 `gap: true`。
5. 不调用主动已读。
6. 登录挑战只返回二维码 data URL 或受认证的验证入口；不得返回 Cookie/Token。
7. 在 `apps/server/src/auth/auth-service.ts` 的工厂中注册。
8. 用 fixture 测试解析；在 mock 环境不可替代真实账号测试，需更新验收记录。

## 6. 添加下载器

1. 实现 `MediaDownloader`。
2. `resolve()` 返回媒体 URL；不要在下载器里写业务数据库。
3. `download()` 写入给定临时路径，支持 AbortSignal 与进度。
4. 在 `DownloadWorker.buildAdapters()` 中排定优先级。
5. 对 403/已删除区分永久失败；对网络/超时允许有限重试。
6. 补充载荷/错误分类测试；真实服务变化需现场验收。

## 7. 数据库迁移

- 迁移数组在 `packages/db/src/migrations.ts`。
- 已发布迁移不可修改；追加新 ID。
- 先 `pnpm backup`，再 `pnpm db:migrate`。
- 更新 `schema.ts` 与类型。
- 集成测试会创建全新数据库，验证 schema 与迁移同步。

## 8. 前端约定

- 所有 API 调用走 `src/api/client.ts`，自动带 CSRF、处理 401。
- 页面通过 `useVaultEvent` 订阅共享 SSE，不自行创建 EventSource。
- 不要在 UI 中输出媒体签名 URL、Session、Cookie、完整文件路径。
- 状态文案集中参考 `components/StatusBadge.tsx`。
- 响应式断点：手机 < 640、桌面侧栏 ≥ 1024。
- 颜色使用 `index.css` 中的 `ink/brand/aqua` token。

## 9. 日志与错误

- 使用 `logger.info/warn/error`，不要 `console.log` 业务流程。
- 不记录 URL、Cookie、Token、密码、二维码。
- 用户可见错误同时保留在任务/同步/健康状态中，不能只打日志。
- 新增错误码请归入 `packages/core/src/errors.ts`，并区分可重试与永久失败。

## 10. 发布检查

GitHub Actions 模板位于 [`.github/ci.yml.example`](../.github/ci.yml.example)。如需启用，将其移动到 `.github/workflows/ci.yml` 后提交；通过 OAuth 凭据推送该路径时，需要 GitHub `workflow` 权限。模板覆盖下列类型检查、模拟测试、构建及浏览器验收，不连接真实抖音账号。

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:fixtures
pnpm test:e2e
pnpm build
pnpm db:migrate
pnpm healthcheck
```

真实账号发布前另需：

- [ ] Phase 0 通过并保存本地验收报告
- [ ] 重新验证 Session 重启恢复
- [ ] 长离线/断网补拉
- [ ] 真实下载 API / yt-dlp
- [ ] launchd 连续运行 24 小时
- [ ] Cloudflare Access 生效
- [ ] 备份恢复演练

## 11. 调试技巧

- 只想看 API：`pnpm dev:server`；Vite 可单独启动。
- 数据库：`sqlite3 data/db/vault.sqlite '.tables'`（只读诊断，不要手改线上数据）。
- 检查任务：`sqlite3 data/db/vault.sqlite "select id,status,attempts,error_code from download_jobs order by created_at desc limit 10;"`。
- 检查同步缺口：`select group_id,status,gap,gap_reason from sync_runs order by started_at desc limit 10;`。
- SSE：`curl -N -b cookie.txt http://127.0.0.1:18760/api/v1/events`。
- 健康：`curl http://127.0.0.1:18760/healthz`。

不要在没有备份、没有停服的情况下删除 `data/db`、`sessions` 或 `media`。
