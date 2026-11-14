# Skill Hub 个人版方案设计

> 基于 2026-11-13 的《SkillHub / 企业级 Agent Skill 全生命周期管理平台调研报告》。
> 定位：个人自用。开源为主（iflytek/skillhub 当核心注册中心），自研补齐它没有的创建、校验、评测环节。

## 1. 选型结论

调研报告里 iflytek/skillhub 是综合第一名：生产级、可私有化、CLI + REST + Web UI 全有、每周发版、中文文档全。短板是评测（只有安全扫描）和技能演化机制没有。

个人自用场景下，它的 RBAC/评审/审计属于"白送"——不需要额外治理成本，单命名空间单账号直接用。

**自研部分只做它缺的三块，全部是本地 CLI，不起服务：**

| 环节 | iflytek/skillhub 现状 | 自研补齐 |
|---|---|---|
| 创建/脚手架 | ⚠️ 只有套装打包 | `init` 从模板生成 skill 目录 |
| 本地校验 | ❌ 无（发布前才知道错） | `validate` 按 agentskills 规范校验 SKILL.md |
| 评测 | ❌ 无 | `eval` 用例驱动，跑 LLM 评测，结果落盘 |
| 发布/版本/搜索/安装 | ✅ 全有 | 不做，直接用它的 REST API 和官方 CLI |
| 演化/证据记录 | ❌ 无 | M3：评测记录 + CHANGELOG 证据链（参考 agent-skills-platform 方法论） |

不重复造注册中心。发布走官方 `POST /api/cli/v1/skills/{namespace}/publish`，安装走官方 `@astron-team/skillhub` CLI，Web UI 直接用。

## 2. 总体架构

```
                本地开发循环（自研 workbench，Node.js CLI "skw"）
  ┌──────────────────────────────────────────────────────┐
  │  skw init → skw validate → skw eval → skw pack → skw publish   │
  │     (脚手架)    (规范校验)   (LLM评测)   (打zip)   (REST上传)      │
  └──────────────────────────────────┬───────────────────┘
                                     │ POST /api/cli/v1/skills/{ns}/publish
                                     ▼
  ┌──────────────────────────────────────────────────────┐
  │        iflytek/skillhub v0.2.26（Docker Compose）      │
  │                                                      │
  │   web(nginx:3000) ── server(Java:8080) ── postgres    │
  │                          │               └─ redis     │
  │                    skill-scanner(静态安全扫描)           │
  │                          │                            │
  │                    skillhub_storage(本地盘存包)          │
  └──────────────────────────────────────────────────────┘
                                     │
        使用/安装：官方 CLI（npx @astron-team/skillhub search/install）
        或直接被 Claude Code / Codex / Cursor 等 30+ 平台加载 SKILL.md
```

自研 workbench 是纯客户端工具，无状态；所有持久化都交给注册中心。

## 3. 目录结构

```
skill hub/
├── docs/design.md              本方案
├── deploy/                     部署（固定 v0.2.26）
│   ├── compose.release.yml     官方编排原样拷贝
│   ├── .env.release            个人配置（密钥/端口/账号）
│   └── .env.release.example    官方完整配置模板，备查
└── workbench/                  自研 CLI
    ├── bin/skw.js              入口
    ├── src/                    config / skill / pack / publish / eval / providers
    ├── templates/default/      init 脚手架模板
    └── package.json
```

## 4. 部署（M0）

部署目标：远端服务器 `<SERVER_IP>`（Ubuntu 24.x，4C / 3.6G 内存 + 1.9G swap / 40G 盘，Docker 29.6.1 + Compose v5.3.0，时区 Asia/Shanghai）。

```bash
# 服务器上（文件已上传到 ~/skillhub/deploy/）
cd ~/skillhub/deploy
docker compose --env-file .env.release -f compose.release.yml up -d
```

- Web UI：http://<SERVER_IP>:3001 （管理员 admin / <ADMIN_PASSWORD>，首次登录后改密码）——云安全组已放行 TCP 3001（2026-11-13），外网直达已验证
- 后端 API：http://<SERVER_IP>:8080 （外网可达，已实测）
- 状态：**已部署并验收（2026-11-13）**，6 容器全部 healthy，扫描流水线正常工作
- 6 个容器：web / server / postgres / redis / skill-scanner / storage-permissions（一次性权限初始化）
- 数据落盘：`postgres_data`、`redis_data`、`skillhub_storage` 三个命名卷

端口规划（服务器实况）：

| 端口 | 用途 | 说明 |
|---|---|---|
| 3000 | ❌ 已被 `ai-harbor` 容器占用 | 不动它 |
| **3001** | skillhub Web UI | 本方案使用 |
| 8080 | skillhub API | 空闲，本方案使用 |
| 5432 / 6379 | postgres / redis | 只绑 127.0.0.1，不对外 |

注意：
- **版本固定 v0.2.26**，升级改 `SKILLHUB_VERSION` 后 `up -d` 即可（Compose 单容器替换，无新旧混跑窗口）
- 镜像在 ghcr.io，服务器拉不动时换阿里云镜像源（改 `SKILLHUB_SERVER_IMAGE` 等三个变量，参考 runtime.sh 的 `--aliyun` 路线）
- 备份 = 定期 `pg_dump` + 导出 `skillhub_storage` 卷
- 登录流程（实测）：Spring Security 契约——先 GET 任意 `/api/v1/*` 拿 `XSRF-TOKEN` cookie，POST 时回传 `X-XSRF-TOKEN` 头；登录端点 `POST /api/v1/auth/direct/login`（body: `provider=local` + username/password）；可用端点清单看 `GET /v3/api-docs`（Swagger 开着）
- 内存偏紧（可用 1.5G + swap 1.6G），Java server 若被 OOM kill，考虑加 `JAVA_TOOL_OPTIONS=-Xmx512m` 限堆

本地连这台服务器的 SSH 有网络限制（直连 22 端口出站被拦），两种通路：
1. Trae 远程资源管理器自身的连接（`ssh -T -D <port> ubuntu@<SERVER_IP>`），其 `-D` 动态 SOCKS 端口可作为跳板
2. [socks5.py](../deploy/socks5.py)（stdlib SOCKS5 客户端）+ [ssh-tunnel.conf](../deploy/ssh-tunnel.conf)：`ssh -F deploy/ssh-tunnel.conf skillhub-remote`，ProxyCommand 借 Trae 隧道转发；隧道端口变了改 conf 里那行即可

注册中心初始化（已完成，2026-11-13）：
1. 命名空间 `personal`：`POST /api/v1/namespaces`，body `{slug, displayName, description}`（注意是 displayName 不是 name）
2. API token：`POST /api/v1/tokens`，body `{name}` → 返回 `sk_Q****`（仅创建时返回一次），已存 `~/.skw/config.json`
3. 验证：`GET /api/cli/v1/auth/whoami`（Bearer token）→ docker-admin；skw publish 全链路已通

## 5. workbench 设计

命令（`node workbench/bin/skw.js`，或 npm link 后全局 `skw`）：

| 命令 | 作用 | 依赖 |
|---|---|---|
| `skw init <name>` | 生成 skill 脚手架（SKILL.md + references/）；`-s/--desc` 直接填 description，不给则留 TODO 占位 | 无 |
| `skw validate [dir]` | 校验 SKILL.md，错误退出码非 0；description 仍是 TODO 占位给警告 | 无 |
| `skw eval [dir]` | 跑 `evals/cases.yaml` 用例，报告写 `evals/runs/` | mock 离线可跑；openai 需 key |
| `skw pack [dir]` | 校验后打 zip 到 `dist/<name>.zip`（zip 根是 SKILL.md；点文件 / `dist` / `evals` / `node_modules` / `.git` 不进包） | 无 |
| `skw publish [dir]` | pack + multipart 上传 `POST /api/cli/v1/skills/{ns}/publish`（file + `--visibility` private\|public） | 注册中心 + token |
| `skw whoami` | 验证 token/registry 配置 | 注册中心 + token |

配置解析顺序：CLI 参数 > 环境变量（`SKILLHUB_URL`、`SKILLHUB_TOKEN`）> `~/.skw/config.json`。config.json 容忍 UTF-8 BOM（Windows 写文件常见坑），解析失败打警告并忽略该文件。

可用性约定（2026-11-13 审核后统一）：所有网络请求带超时（publish/whoami 30s，LLM 120s）；HTTP 错误体截断到 500 字符防 HTML 刷屏；401/403 附人话提示（token 失效 vs 无权限）；fetch 网络错误打印 `e.cause` 真实原因。

### 校验规则（validate）

- `name`：必填，`^[a-z0-9][a-z0-9-]*$`，≤64 字符，与目录名不一致给 warning
- `description`：必填，≤1024 字符（agentskills 规范），一句话讲清"做什么+何时用"；含 TODO 占位给 warning 拦在发布前
- 正文非空
- frontmatter 用 gray-matter 解析，非法 YAML 报错
- 规则不对齐官方规范时以 agentskills.io 为准，代码里集中在一处方便改

### 评测（eval）

用例格式（skill 目录内 `evals/cases.yaml`）：

```yaml
cases:
  - id: demo-1
    input: 用户的示例输入
    expect_contains:            # 输出必须包含的关键词，全部命中才算过
      - 关键词A
```

- Provider 可插拔：`--provider mock`（离线，回显输入，用于流程验证）/ `openai`（OpenAI 兼容接口，环境变量 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`）
- Prompt 结构：system = SKILL.md 全文，user = case.input
- 结果写 `evals/runs/run-<时间戳>.json`：每个 case 的输出、断言结果、耗时；控制台汇总表；有失败则退出码非 0（可挂 git hook / CI）
- 断言先只做 `expect_contains`，后续按需加 `expect_regex` / LLM-as-judge

### 发布（publish）

实测契约（v0.2.26）：`POST /api/cli/v1/skills/{namespace}/publish`，multipart 只有 `file`（+ 可选 `visibility`），namespace 在路径里；Bearer token、`X-Request-Id`（uuid，幂等）、统一 `{code,msg,data}` 信封解包。whoami 是 `GET /api/cli/v1/auth/whoami`。

## 6. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | 部署注册中心 ✅ | compose up 全部 healthy，admin 直登 API 验证通过（2026-11-13） |
| M1 | workbench init/validate/pack/publish ✅ | demo-skill 已发布到 personal 命名空间，resolve/download 可用（2026-11-13） |
| M2 | eval 接真实 LLM | 评测报告落盘，失败 case 能拦截发布 |
| M3 | 演化记录 | 修改 skill 必须附新评测记录 + CHANGELOG 条目（证据链） |

M3 之后再考虑：使用统计聚合（下载量在注册中心已有，够个人用）、JIT 推荐（参考 skills-vote）这些重活。

## 7. 风险与备注

- **ghcr.io 拉取**：国内网络可能失败，备选 gh-proxy / Docker 代理 / 阿里云镜像（runtime.sh 的 `--aliyun` 路线）
- **直登 provider id**：已实测为 `local`（`GET /api/v1/auth/methods` 确认）
- **上游升级**：workbench 依赖 `/api/cli/v1`（publish/whoami/resolve），上游每周发版；升级前跑一遍发布链路验证
- **zip 结构**：官方要求 zip 根目录就是 SKILL.md，pack 已按此处理
- **密钥**：`.env.release` 含密码和随机密钥，不进 git（加 .gitignore）
