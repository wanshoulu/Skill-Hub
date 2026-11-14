# Skill Hub

基于 [iflytek/skillhub](https://github.com/iflytek/skillhub) v0.2.26 的**个人版 Agent 技能全生命周期平台**：技能创建 → 检查扫描 → 真实测评 → 进化迭代 → 发布到注册中心 → 市场浏览 → 一键安装到内置 Agent → 真实对话试运行，端到端打通。

上游 skillhub 提供生产级注册中心（REST + CLI + Web UI、命名空间、版本管理、搜索、安装）；本仓库自研补齐它缺失的环节（脚手架、本地校验、LLM 评测、多轮进化），并新增两个 Agent 服务（对话式技能创建、技能应用试运行）。

## 总体架构

```
  本地/浏览器                                   服务器（单机 Docker Compose）
┌─────────────────────┐          ┌────────────────────────────────────────────┐
│ skw CLI（workbench） │          │ web 容器（:3001 对外，定制 nginx 镜像）        │
│  init / validate     │          │  /            → SPA（含「技能构建」「技能应用」页）│
│  gate / pack         │──HTTP───►│  /api/         → skillhub server(8080)       │
│  publish             │          │  /gate-api/    → gate:3002         (REST)    │
└─────────────────────┘          │  /build-api/   → skill-build-agent:8300 (SSE)│
                                 │  /app-api/     → skill-app-agent:8310  (SSE) │
                                 ├────────────────────────────────────────────┤
                                 │ gate-service（Node :3002）                    │
                                 │  统一对话入口 + 意图路由 / 检查 / 测评 / 进化     │
                                 │  证据链 JSON 落盘 /data（digest 级缓存）        │
                                 ├────────────────────────────────────────────┤
                                 │ skill-build-agent（Python :8300）             │
                                 │  openjiuwen DeepAgent 对话式创建技能           │
                                 ├────────────────────────────────────────────┤
                                 │ skill-app-agent（Python :8310）               │
                                 │  DeepAgent + 技能库按需加载 + 脚本真实执行      │
                                 ├────────────────────────────────────────────┤
                                 │ skillhub 注册中心（8080，原样不动）             │
                                 │  web / server / postgres / redis              │
                                 │  skill-scanner / storage-permissions          │
                                 └────────────────────────────────────────────┘
```

**流量收口**：页面与 CLI 统一走 `:3001`（nginx 反代 `/gate-api/`、`/build-api/`、`/app-api/`），3002/8300/8310 仅 Docker 网络内可达，对外只需开放 3001。

## 目录结构

```
skill-hub/
├── skillhub-src/            上游 iflytek/skillhub v0.2.26 源码 + web 定制（见下）
├── workbench/               自研 CLI「skw」（Node.js）
│   ├── bin/skw.js           入口
│   ├── src/                 config / skill / pack / publish / eval / providers
│   └── templates/default/   init 脚手架模板
├── gate-service/            技能构建门禁服务（Node，:3002）
│   └── src/                 auth / orchestrator / llm / judge / stages / pack / evolve
├── skill-app-agent/         技能应用试运行服务（Python，:8310）
│   ├── app/                 main / agent_factory / registry_client / skill_installer / tools / rails / sse
│   └── probe.py             三轮对话冒烟探针
├── deploy/                  部署编排
│   ├── compose.release.yml  上游 6 服务编排（web 已固化定制镜像与反代上游）
│   ├── gate-compose.yml     gate / skill-build-agent / skill-app-agent 三个新增服务
│   ├── skill-build-agent.Dockerfile
│   ├── web-custom/          web 定制镜像（Dockerfile + nginx 模板 + overlay）
│   ├── seed/skills-custom/  预置种子技能
│   ├── .env.release.example 上游完整配置模板（真实配置 .env.release 不入库）
│   └── .env.gate.example    gate / agent 服务的 LLM 与令牌配置模板
├── docs/
│   ├── design.md            总体方案（选型、架构、部署、workbench 设计、里程碑）
│   └── gate-design.md       G 系列功能设计（创建/检查/测评/进化/技能应用，含 API 契约）
└── README.md
```

## 核心组件

| 组件 | 端口 | 职责 |
|---|---|---|
| **workbench（skw CLI）** | — | `init` 脚手架 → `validate` 规范校验 → `eval` LLM 评测 → `gate` 门禁检查 → `pack` 打包 → `publish` REST 发布；纯客户端无状态 |
| **gate-service** | 3002（内网） | 统一对话入口（SSE 意图路由：create 转发创建 Agent，其余跑流水线）；basic 五项静态检查（秒级无 LLM）；runtime 真实 LLM 用例测评；多轮反思进化 + 复评消噪；证据链以 `content_digest = sha256(zip)` 绑定、同内容同数据集不重跑 |
| **skill-build-agent** | 8300（内网） | openjiuwen 0.1.17.post1 DeepAgent，对话式创建技能草稿（`/data/drafts/`） |
| **skill-app-agent** | 8310（内网） | 技能应用试运行：注册中心技能真实安装到 DeepAgent（resolve→download→安全解压），技能内容按需加载，`run_skill_script` 子进程真实执行技能脚本（60s 超时、输出截断、防路径穿越） |
| **web（定制镜像）** | 3001（对外） | 上游 SPA + 新增「技能构建」「技能应用」页 + 市场详情页「安装到 Agent」按钮；nginx 反代三组定制 API（SSE 配置：`proxy_buffering off` + 300s） |
| **上游 6 服务** | 8080 等 | web / server(Java) / postgres / redis / skill-scanner（静态安全扫描）/ storage-permissions，注册中心原样不动 |

## 快速开始

### 1. 准备配置

```bash
cd deploy
cp .env.release.example .env.release    # 上游 6 服务配置：端口、管理员、cookie 签名密钥等
cp .env.gate.example .env.gate          # gate / agent 服务配置：GATE_TOKEN、LLM 模型源（OpenAI 兼容）、AUTO_INSTALL_SKILLS
# 编辑两个 .env：把 TODO 值全部替换；.env.release 含密钥，不要提交
```

### 2. 构建定制镜像

```bash
# web 定制镜像：需要先在 skillhub-src/web 下 npm ci && npm run build 得到 dist，
# 将 dist 与 deploy/web-custom 内容放入同一构建上下文（见 deploy/web-custom/web.custom.Dockerfile）
docker build -t skillhub-web-custom:v0.2.26.3 -f deploy/web-custom/web.custom.Dockerfile <web-build-context>

# gate-service 与两个 agent
docker build -t gate-service:0.1.0        -f gate-service/Dockerfile       gate-service
docker build -t skill-build-agent:0.1.0   -f deploy/skill-build-agent.Dockerfile .
docker build -t skill-app-agent:0.1.0     -f skill-app-agent/Dockerfile    skill-app-agent
```

### 3. 启动

```bash
cd deploy
# 上游 6 服务（web 段已固化定制镜像与 GATE_API_UPSTREAM/BUILD_AGENT_UPSTREAM/APP_API_UPSTREAM，
# 不要用无 overlay 的旧编排覆盖 web，否则定制反代会整体回退）
docker compose --env-file .env.release -f compose.release.yml up -d
# 三个新增服务（加入 skillhub 网络）
docker compose --env-file .env.gate -f gate-compose.yml up -d
```

### 4. 访问与令牌

- Web UI：`http://<SERVER_IP>:3001`（管理员账号在 `.env.release` 的 `BOOTSTRAP_ADMIN_*` 中设置）
- 三组特权 API（`/gate-api`、`/build-api`、`/app-api`）使用 **Bearer 令牌鉴权**：服务端读取 `.env.gate` 的 `GATE_TOKEN`，前端在「技能构建」或「技能应用」页右上角 **「配置令牌」** 对话框填入同一个值（存 localStorage，每个浏览器配一次）。令牌的意义：这些接口能在服务器上执行构建、安装技能、运行技能脚本，必须验证操作者是管理员。

## 端到端使用流程

```
① 创建          ② 本地校验        ③ 门禁检查           ④ 评测/进化（可选）
skw init    →   skw validate  →   skw gate         →   页面对话驱动 evolve
（脚手架模板）   （agentskills 规范） （basic 五项静态检查）  （多轮反思迭代+复评消噪）

⑤ 发布                ⑥ 市场浏览             ⑦ 安装到 Agent                ⑧ 真实试运行
skw pack + publish →  Web UI 技能市场     →  详情页「安装到 Agent」或      「技能应用」页 SSE 对话：
（REST 上传注册中心）   搜索/详情/版本       「技能应用」页搜索安装         技能按需加载 + 脚本真实执行
```

- CLI 主循环：`skw init → validate → eval → pack → publish`，发布走官方 `POST /api/cli/v1/skills/{namespace}/publish`
- 市场详情页的「安装到 Agent」与「技能应用」页的注册中心安装共用同一服务端 API（`/app-api/v1/skills/install`），安装即注册到 Agent 的技能库；重复安装返回 409（前端视为已安装）
- 试运行对话事件流（SSE）：`phase / token / skill_load / tool / result / error / hb / done`，前端呈现过程时间线（加载技能 → 执行脚本 → 回复生成）

## skill-app-agent 设计要点

- **per-fp 技能库副本**：技能目录树指纹（sha256，忽略隐藏文件）→ agent 实例缓存；install/uninstall 后指纹变化自动重建，每个指纹独立 workspace `/data/workspace/run-<fp8>`（openjiuwen 文件锁被已初始化 agent 持久持有，路径重叠会死锁）
- **框架锁 patch**：openjiuwen 0.1.17.post1 的 `HybridAsyncReadWriteLock` 与新版 filelock 的 task 归属检查冲突（子 task acquire、当前协程 release → 锁永不释放 → 同路径二次写永久挂起），导入时 monkeypatch 修复，多轮对话死锁根除
- **安全**：技能 zip 安全解压（拒绝绝对路径/穿越，缺 SKILL.md 回滚）；卸载名白名单校验；脚本执行路径 resolve 防穿越；agent permissions 默认全 deny，仅放行 skill 工具
- **预置技能**：`AUTO_INSTALL_SKILLS=personal/stock-lookup` 启动时 best-effort 安装（3 次重试）
- **MVP 边界**：仅支持纯标准库脚本技能

## API 概览（经 :3001 nginx 反代）

| 前缀 | 上游 | 主要端点 |
|---|---|---|
| `/gate-api/` | gate-service:3002 | `POST /v1/agent/chat`（统一对话 SSE）、`POST /v1/drafts`、`POST /v1/gate/run`、`POST /v1/eval/run`、`POST /v1/evolve/run`、`GET /v1/evidence/...` |
| `/build-api/` | skill-build-agent:8300 | `POST /api/skill-build-agent/chat`（对话创建 SSE）、`GET .../skills`（技能库） |
| `/app-api/` | skill-app-agent:8310 | `GET /v1/agent`、`GET /v1/skills/registry`、`POST /v1/skills/install|uninstall`、`POST /v1/chat`（试运行 SSE）、`POST /v1/session/reset`、`GET /v1/healthz`（免鉴权） |
| `/api/` | skillhub server:8080 | 上游注册中心原生 API（登录、发布、搜索、命名空间等） |

## 相对上游的定制点

| 文件 | 改动 |
|---|---|
| `web/src/pages/build.tsx` / `applications.tsx` | 新增「技能构建」「技能应用」两个一级页面 |
| `web/src/api/gateClient.ts` / `appClient.ts` | 两组同源 API 客户端（复用 localStorage `gateToken`） |
| `web/src/features/skill/install-for-agent-button.tsx` | 市场详情页一键安装到 Agent（含安装态预查） |
| `web/src/app/layout.tsx` / `router.tsx` | 导航与路由（「技能应用」位于「技能套件」与「控制台」之间） |
| `web/src/i18n/locales/*.json` | 四语言文案 |
| `web/vite.config.ts` / `nginx.conf.template` | dev proxy 与生产反代（`/gate-api/`、`/build-api/`、`/app-api/`） |
| `deploy/compose.release.yml` web 段 | 定制镜像 + 三个反代上游固化写入 |

## 文档

- [docs/design.md](docs/design.md) — 总体方案：选型结论、总体架构、部署（M0）、workbench 设计、里程碑
- [docs/gate-design.md](docs/gate-design.md) — G 系列功能设计：技能创建 / 检查扫描 / 测评 / 进化 / gate-service API 契约 / 前端页面 / 技能应用（G9）

## 上游与许可

- 注册中心核心：[iflytek/skillhub](https://github.com/iflytek/skillhub)（Apache-2.0），本仓库 `skillhub-src/` 为其 v0.2.26 源码加定制修改，上游权利归原项目所有
- 自研部分：workbench（skw CLI）、gate-service、skill-app-agent、deploy 编排与种子技能
