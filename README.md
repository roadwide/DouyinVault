# Douyin Vault · 抖音时光仓

**把群聊里值得留下的视频，收进自己的视频库。**

Douyin Vault 是一个本地优先、自托管的抖音群聊视频归档工具。它监听你选择的群聊，将分享的视频缓存到本地，并通过浏览器提供搜索、播放、观看进度和收藏管理。

[快速开始](#快速开始) · [连接抖音](#连接抖音) · [部署文档](docs/deployment.md) · [参与贡献](#参与贡献) · [报告问题](https://github.com/roadwide/DouyinVault/issues)

> **项目状态：早期开发 / 实验性。** 演示模式已覆盖自动化测试；真实账号接入依赖第三方适配器和平台行为，完整场景与长期稳定性仍需验证。接入前请阅读 [已知限制](docs/known-limitations.md) 和 [真实账号验收指南](docs/acceptance.md)。

## 功能特性

- **自动归档**：识别群聊作品卡片与文本链接，通过持久化下载队列完成缓存、重试与恢复。
- **按群订阅**：所有群聊默认关闭，只监听手动启用的群；同一作品跨群分享只保存一份。
- **本地视频库**：搜索与筛选、拖动播放、未观看标记、观看进度和收藏，支持手机与桌面浏览器。
- **存储管理**：按保留期和容量自动清理，提供孤儿文件检查与 SQLite 在线备份。
- **连接与任务状态**：查看账号连接、群同步、下载进度、失败原因与历史消息缺口。
- **数据自持**：视频、封面、会话与数据库保存在自己的设备上；管理接口和媒体访问均需认证。

只有在源作品失效前已完整缓存的视频，才能继续在本地观看。当前面向单账号、单管理员使用；群内原生视频文件、图集、直播回放和多用户暂不支持。

## 快速开始

先用演示模式体验界面与归档流程，无需连接抖音账号。

### 环境要求

| 依赖 | 要求 |
| --- | --- |
| Node.js | 22.13 或更高版本，建议使用 Node.js 22 |
| pnpm | 10，仓库通过 `packageManager` 指定版本 |
| ffmpeg / ffprobe | 可从命令行调用，用于媒体校验与演示短片生成 |

项目优先支持原生 macOS 部署。Docker 配置已提供，真实账号链路的验证范围见 [部署文档](docs/deployment.md)。

### 安装与启动

```bash
git clone https://github.com/roadwide/DouyinVault.git
cd DouyinVault

pnpm install --frozen-lockfile
cp .env.example .env

pnpm build
pnpm demo:seed
pnpm start
```

`.env.example` 默认启用 `IM_ADAPTER=mock` 和 `DEMO_MODE=true`。`demo:seed` 会生成 6 个可播放短片，以及用于体验界面的模拟群聊和失败记录；请在独立的空数据目录中运行。

保持服务运行，在另一个终端进入项目目录，获取首次安装令牌：

```bash
pnpm setup-token
```

打开 **<http://127.0.0.1:18760>**，使用令牌设置管理员密码。令牌在设置完成后自动删除；如已通过 `.env` 配置 `ADMIN_PASSWORD`，直接使用该密码登录。

## 连接抖音

演示模式与真实账号使用不同的适配器。准备接入时，先使用专门的测试账号和受控群聊，按 [验收指南](docs/acceptance.md) 验证登录、收消息、下载、重启恢复与断线重连。

主要配置项如下，完整示例见 [`.env.example`](.env.example)：

| 配置项 | 用途 |
| --- | --- |
| `IM_ADAPTER` | `mock` 为演示；`douyin-im` 为主要接入路径；`playwright` 为实验性备用方案 |
| `DEMO_MODE` | 接入真实账号时设为 `false`；生产环境强制关闭 |
| `DATA_DIR` | 数据目录，默认 `./data`；建议将真实数据与演示数据分开 |
| `PUBLIC_ORIGIN` | 浏览器实际访问的完整 Origin，用于请求来源校验 |
| `ADMIN_PASSWORD` | 可选；留空时通过首次安装令牌设置密码 |
| `DTK_BASE_URL` / `DTK_API_KEY` | 可选的独立下载 API 地址与凭据 |

连接成功后，在「群聊」页面逐个启用需要归档的群。macOS 常驻服务、HTTPS 远程访问、Cloudflare Tunnel / Access、备份与升级步骤见 [部署文档](docs/deployment.md)。

## 工作原理

```text
获授权的群聊
    ↓
消息监听 → 作品识别 → 群过滤与去重
    ↓
SQLite 持久化队列 → 下载、校验与恢复
    ↓
本地媒体文件 + 元数据
    ↓
浏览器视频库
```

后端使用 **Fastify + SQLite / Drizzle**，前端使用 **React + Vite + Tailwind CSS**。IM 与下载器通过适配器接入，支持在离线模拟环境下开发和测试。

```text
apps/
  server/                  API、下载队列、调度与认证
  web/                     响应式视频库与管理界面
packages/
  core/                    消息标准化、去重与保留策略
  db/                      数据结构与迁移
  im-adapters/             mock、douyin-im、Playwright
  downloader-adapters/     Direct、Douyin API、yt-dlp
  shared/                  公共工具
scripts/                   开发、部署与维护脚本
tests/                     单元、集成、样本与浏览器测试
docs/                      设计、部署与使用文档
```

更多实现细节见 [架构设计](docs/architecture.md) 和 [实现说明](docs/implementation.md)。

## 本地开发

完成依赖安装和 `.env` 配置后，运行：

```bash
pnpm dev
```

前端地址为 <http://127.0.0.1:5173>，API 地址为 <http://127.0.0.1:18760>。开发时使用 mock 适配器即可。

```bash
pnpm test:all                       # 类型检查、单元、集成与样本测试
pnpm exec playwright install chromium
pnpm test:e2e                       # 构建并运行桌面 / 移动端浏览器测试
```

GitHub Actions 配置以 [CI 模板](.github/ci.yml.example) 提供，当前未启用。配置方式和真实账号测试说明见 [开发指南](docs/development.md)。

### 常用维护命令

| 命令 | 作用 |
| --- | --- |
| `pnpm build` / `pnpm start` | 构建 / 启动应用 |
| `pnpm healthcheck` | 检查服务健康状态 |
| `pnpm db:migrate` | 应用数据库迁移 |
| `pnpm backup` | 在线备份 SQLite 数据库，保留最近 7 份 |
| `pnpm cleanup` | 通过已运行服务执行清理 |
| `pnpm reset-password` | 在本机重置管理员密码 |
| `pnpm live:preflight` | 检查真实账号接入所需的本机依赖 |

## 数据与隐私

默认数据目录为 `data/`，包含数据库、媒体、抖音会话、日志与备份。管理接口使用会话认证与 CSRF 校验，视频和封面也需登录后访问。

- 服务默认监听 `127.0.0.1`；远程访问请配置 HTTPS 和 Cloudflare Access 或等价访问保护。
- `.env`、账号会话、真实群聊数据、二维码、媒体和日志不应提交到仓库。个人部署记录可放入已忽略的 `docs/*.local.md`。
- 数据库备份包含消息元数据与管理员密码哈希，应按敏感文件保管；视频文件需要单独备份。

完整安全模型见 [安全文档](docs/security.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [部署指南](docs/deployment.md) | macOS 常驻服务、远程访问、备份与升级 |
| [开发指南](docs/development.md) | 开发环境、适配器扩展与测试 |
| [架构设计](docs/architecture.md) · [实现说明](docs/implementation.md) | 模块边界、数据流与工程细节 |
| [验收指南](docs/acceptance.md) | 真实账号接入验证 |
| [已知限制](docs/known-limitations.md) | 支持范围、实验性能力与验证状态 |
| [故障排查](docs/troubleshooting.md) · [安全模型](docs/security.md) | 常见问题与部署安全 |

## 参与贡献

欢迎通过 [Issues](https://github.com/roadwide/DouyinVault/issues) 报告问题、讨论功能，或提交 [Pull Request](https://github.com/roadwide/DouyinVault/pulls)。

- **报告问题**：附上运行环境、复现步骤、预期行为与实际结果；日志和截图请先脱敏。
- **提交代码**：Fork 仓库后创建分支，说明改动目的与验证方式，运行与改动相关的检查。
- **改进适配器**：附上脱敏样本与回归测试，注明模拟环境和真实账号分别验证了哪些场景。
- **完善文档**：安装体验、排错步骤和平台兼容性记录同样欢迎。

## 许可证

当前仓库尚未添加 `LICENSE` 文件，许可证信息待补充。

## 使用说明

请仅归档你已获授权访问的群聊内容，并尊重内容创作者与群成员的权益。本项目与抖音官方无隶属关系；平台接口、消息格式和访问权限的变化可能影响接入能力。
