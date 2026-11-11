# Douyin Vault · 抖音时光仓

本地优先的抖音群聊视频自动归档系统。程序在你自己的 Mac mini 上监听获授权的群聊，把群友分享的视频尽快缓存到本地，并提供浏览器视频库、观看进度、收藏与自动清理。

> **交付状态（务必先读）**
>
> 本仓库实现了完整的 MVP 工程链路：SQLite 持久化队列、消息去重、双群来源合并、范围请求播放、失败重试、崩溃恢复、容量清理、备份、管理认证与响应式 Web 界面；模拟适配器下的自动化测试全部通过。
>
> **但真实抖音账号的 Phase 0 现场验收尚未在本构建环境完成。** `douyin-im` 适配器、Playwright 备用适配器与独立下载 API 都必须在你的测试账号上重新验证。工程完成不等于平台链路可用。请在 `docs/acceptance.md` 的 Phase 0 关卡通过后，再把本项目用于日常归档。

---

## 它解决什么问题

- 上午 11:00，群友分享一个视频，你在工作，没有打开抖音。
- 本机程序发现消息，在作品失效前缓存视频。
- 晚上 23:00，你打开 `vault.example.com`，直接看到这条未观看的视频。
- 即使作者删除原作品，只要本地缓存成功，视频仍能播放。

核心链路只有一条：

```
群友分享 → 自动监听 → 自动下载 → 本地永久文件 → 随时回看
```

## 当前能力

| 能力 | 状态 |
|---|---|
| 扫码登录 / Session 恢复 | 适配器已实现，真实账号待验收 |
| 指定群聊监听、默认全关 | 已完成并测试 |
| 作品卡片 / 文本链接识别 | 已完成并测试 |
| 自动下载、优先级、重试 | 已完成并测试 |
| 多群同一作品只存一份 | 已完成并测试 |
| 本地视频库、Range 拖动播放 | 已完成并测试 |
| 已缓存视频的源作品可访问性标签 | 已完成并测试 |
| 未观看 / 已观看 / 收藏 | 已完成并测试 |
| 删除两阶段与审计 | 已完成并测试 |
| 保留期、容量上限、孤儿扫描 | 已完成并测试 |
| 崩溃恢复 / 租约 / 文件一致性 | 已完成并测试 |
| 断线补拉与缺口记录 | 逻辑已完成，真实接口待验收 |
| 群内原生视频文件 | 仅保留诊断，尚未支持 |
| 图集、图片、直播回放 | 不支持 |
| 多账号、多用户 | 不支持 |

## 架构

单机模块化单体，无 Redis、无云服务器、无 AI：

```
抖音账号 / 群聊
      │
      ├─ douyin-im WebSocket（首选）
      └─ Playwright 浏览器监听（实验性备用）
      │
NormalizedMessage
      │
消息标准化 → 群过滤 → 去重 → SQLite 任务
      │
持久化下载队列（优先级 / 租约 / 重试 / 崩溃恢复）
      │
IM 会话直链 → Direct → Douyin API → yt-dlp
      │
临时文件 → ffprobe/SHA-256 校验 → 原子移动
      │
SQLite 业务库 + 本地媒体
      │
Fastify API + SSE + React Web
```

- `apps/server`：Fastify API、SSE、下载 Worker、清理调度、健康检查
- `apps/web`：React 19 + Vite + Tailwind 响应式管理界面
- `packages/core`：标准化消息、去重键、保留策略、状态机等纯领域逻辑
- `packages/db`：Drizzle schema、SQLite 迁移、任务与观看状态
- `packages/im-adapters`：mock / douyin-im / Playwright
- `packages/downloader-adapters`：Direct / Douyin API v4+v5 / yt-dlp
- 数据默认在 `data/`：SQLite、Session、媒体、临时文件、日志、备份

详细设计见 [docs/architecture.md](docs/architecture.md) 与 [docs/implementation.md](docs/implementation.md)。

## 快速开始（演示模式，不连接抖音）

需要 Node.js 22.13+（推荐最新 22 LTS）、pnpm 10、ffmpeg/ffprobe。

```bash
pnpm install
cp .env.example .env

# 编辑 .env，至少设置：
#   ADMIN_PASSWORD=demo-password-123
#   IM_ADAPTER=mock
#   DEMO_MODE=true

pnpm build
pnpm demo:seed     # 仅在空数据目录运行，生成 6 个真实可播放短片
pnpm start
```

打开 <http://127.0.0.1:18760>，使用 `.env` 中的管理员密码登录。演示数据包含 6 个缓存视频、1 个失败记录、1 条未解析卡片和 2 个已启用群聊。

开发模式：

```bash
pnpm dev          # Vite :5173 + API :18760
```

如果没有设置 `ADMIN_PASSWORD`，首次启动会生成一次性安装令牌：

```bash
pnpm setup-token
```

该令牌保存在 `data/sessions/setup-token.txt`，设置密码后自动删除。

## 真实账号使用

1. **先完成 Phase 0**：使用专门测试账号和两个受控群聊，按 [docs/acceptance.md](docs/acceptance.md) 验证登录、收消息、作品解析、下载、重启恢复与断网重连。
2. 配置 `.env`：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=18760
DATA_DIR=./data
PUBLIC_ORIGIN=https://vault.example.com
IM_ADAPTER=douyin-im
DEMO_MODE=false
```

3. 构建并迁移：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
```

4. 安装为 macOS 常驻服务：

```bash
bash scripts/install-launchd.sh
```

5. 通过本机或 Cloudflare Tunnel 打开页面，获取安装令牌、设置管理员密码、扫码连接抖音，然后逐个启用需要监听的群。
6. 按 [docs/deployment.md](docs/deployment.md) 配置 Cloudflare Tunnel 与 Access。

服务只监听 `127.0.0.1`。不要把端口直接暴露到公网。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 前后端开发模式 |
| `pnpm build` | 构建 Web 与服务端 |
| `pnpm start` | 启动已构建服务 |
| `pnpm typecheck` | 全部包 + 脚本 + 测试类型检查 |
| `pnpm test` | 领域逻辑单元测试 |
| `pnpm test:integration` | SQLite、队列、下载、API、恢复测试 |
| `pnpm test:fixtures` | 录制样本回归 |
| `pnpm test:e2e` | 构建并运行 Playwright 桌面/移动端验收 |
| `pnpm test:live` | 真实账号现场 harness（显式开启） |
| `pnpm live:preflight` | 检查本机依赖，不登录抖音 |
| `pnpm healthcheck` | 调用 `/healthz`，可选详细状态 |
| `pnpm backup` | SQLite 在线备份，保留最近 7 份 |
| `pnpm cleanup` | 通过已运行服务的 API 执行一次清理 |
| `pnpm setup-token` | 打印首次安装令牌 |
| `pnpm reset-password` | 本机重置管理员密码（需显式确认） |
| `pnpm db:migrate` | 应用数据库迁移 |
| `pnpm demo:seed` | 生成演示数据（仅 mock / 空目录） |

GitHub Actions 配置以 [CI 模板](.github/ci.yml.example) 提供，启用方式见 [开发指南](docs/development.md#10-发布检查)。

真实账号测试默认关闭。仅使用专门测试账号：

```bash
pnpm live:preflight
RUN_LIVE_TESTS=1 RUN_LIVE_DATA_DIR=./data/live-check pnpm test:live
```

测试记录写入 `docs/acceptance-report.local.md`，已被 `.gitignore` 忽略。**不要提交二维码、Session、真实群聊数据或缓存视频。**

## 数据与隐私

- 公开仓库只包含源码、通用配置示例和模拟测试数据；实际部署记录请放入 `docs/*.local.md`。
- `.env`、部署凭据、SQLite、抖音 Session、媒体、日志与测试报告均不应提交或放入构建上下文。
- 视频、封面、SQLite、抖音 Session 都在本机 `data/`。
- Session 目录权限 `0700`，数据库与会话文件 `0600`。
- 管理接口要求登录 Cookie + CSRF；媒体流同样需要认证。
- 不把磁盘媒体目录映射成静态目录，不支持匿名媒体 URL。
- 不调用抖音主动已读接口；缓存视频不会改变群消息已读状态。
- 默认只保存视频分享所需的元数据，不永久保存普通文本和图片。
- 签名媒体 URL 只存在内存中，不写入日志、数据库备份或 API 响应。
- 备份仍包含消息元数据和管理员密码哈希，请按敏感文件保管。

详见 [docs/security.md](docs/security.md)。

## 已知限制

真实账号链路、独立下载 API、Playwright 备用适配器、群内原生视频、图集/直播、HLS 直链、多账号与多用户等能力的状态，完整列在 [docs/known-limitations.md](docs/known-limitations.md)。不要根据模拟测试或 README 宣称真实抖音链路已经可用。

## 文档

- [架构](docs/architecture.md)
- [实现说明](docs/implementation.md)
- [开发指南](docs/development.md)
- [Mac mini 部署](docs/deployment.md)
- [安全模型](docs/security.md)
- [验收规范与 Phase 0](docs/acceptance.md)
- [已知限制](docs/known-limitations.md)
- [故障排查](docs/troubleshooting.md)

## 使用边界

本项目用于缓存你已获授权访问的群聊内容。请遵守抖音平台条款、版权规则与适用法律；不要用它突破群权限、作品访问控制或平台限制。视频是否仍可回看，只取决于失效前是否已经完整缓存在本地。
