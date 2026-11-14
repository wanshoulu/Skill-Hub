# 技能构建平台功能设计方案（G 系列）

> 目标：把 OntoMind 的 skill 构建/测评/进化能力，从「发布前视角」整合进服务器上的 skillhub 平台。
> 功能命名（对齐用户口径）：**技能创建 / 技能检查扫描 / 技能测评 / 技能进化**。
> 已确认决策：① LLM 源 = AI Harbor 的 qwen 配置；② 新增轻量服务容器（gate-service + skill-build-agent）；③ publish 在 CLI 侧强制过门禁（注册中心 v0.2.26 原样不动）；④ 站点内嵌「技能构建」页（首页与发布之间）= **对话式统一界面**——整页即对话框工作台，四项任务都从对话发起，底层 agent + skill 支撑，风格与站内一致；⑤ 服务器可出公网，LLM 直连 `maas.qianwenaiapi.com` + QWEN_KEY（部署时 curl 实测，结果进 healthz）；⑥ 5 个存量技能作为首批数据发布进注册中心。

## 0. 模型源（已查明）

本地 AI Harbor 的模型路由表（config/api-keys.js）：

| 通路 | 端点 | 模型 | 鉴权 |
|---|---|---|---|
| A：maas 直连（首选） | `https://maas.qianwenaiapi.com/compatible-mode/v1/chat/completions` | `qwen3.7-flash`（兜底 `qwen-plus`） | `QWEN_KEY`（sk-sp-...） |
| B：ai-harbor 内部网关（备选） | `http://ai-harbor:3000/api/ai-bank/v1/internal/model/v1/chat/completions` | `qwen3.7-flash` | 实例级 runtime token（svc_...） |

部署时按 A → B 顺序探测，第一个通的写入服务器 `.env`。两个新服务共用同一组 LLM 环境变量：gate-service 用 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`，skill-build-agent 用其原生约定 `LLM_API_BASE/LLM_API_KEY/LLM_MODEL`（config.py）。两条全不通则 runtime 阶段明确报错（不做降级放行）。

## 1. 总体架构

```
  本地笔记本                              服务器 <SERVER_IP>
┌─────────────────────┐              ┌────────────────────────────────────────────┐
│ skw CLI（workbench） │              │ web 容器（:3001，定制镜像，nginx）             │
│  init / validate     │              │  /              → SPA（新增「技能构建」页）     │
│  gate / publish      │──HTTPS──────►│  /api/          → skillhub server(8080)      │
└─────────────────────┘              │  /gate-api/     → gate:3002        （REST）   │
                                     │  /build-api/    → skill-build-agent:8300（SSE）│
                                     │  /app-api/      → skill-app-agent:8310（SSE）  │
                                     ├────────────────────────────────────────────┤
                                     │ gate-service（新增 Node 容器，内部 :3002）      │
                                     │  POST /v1/agent/chat  统一对话入口（SSE 意图路由）│
                                     │  POST /v1/drafts               技能创建-草稿  │
                                     │  POST /v1/gate/run             技能检查扫描   │
                                     │  POST /v1/eval/run             技能测评      │
                                     │  POST /v1/evolve/run           技能进化      │
                                     │  GET  /v1/evidence/...         证据链        │
                                     │  存储：/data 下 JSON 文件 + drafts 目录        │
                                     ├────────────────────────────────────────────┤
                                     │ skill-build-agent（新增 Python 容器，内部:8300）│
                                     │  POST /api/skill-build-agent/chat  对话创建 SSE│
                                     │  GET  /api/skill-build-agent/skills 技能库    │
                                     │  openjiuwen 0.1.17.post1，纯对话 DeepAgent    │
                                     ├────────────────────────────────────────────┤
                                     │ skill-app-agent（新增 Python 容器，内部:8310） │
                                     │  POST /v1/chat  技能应用试运行 SSE（G9）       │
                                     │  GET  /v1/agent · /v1/skills/registry          │
                                     │  POST /v1/skills/install|uninstall · /v1/session/reset │
                                     │  openjiuwen DeepAgent：skills=[技能库] 按需加载 │
                                     │  + run_skill_script 自定义工具真实执行脚本      │
                                     ├────────────────────────────────────────────┤
                                     │ skillhub 注册中心（8080，原样不动）             │
                                     │ ai-harbor（3000，已存在）→ 模型网关备选通路 B    │
                                     └────────────────────────────────────────────┘
```

- gate-service 无数据库进程，证据/报告以 JSON 文件落盘 `/data`（对齐 OntoMind skill-checks 做法）；创建的草稿落 `/data/drafts/`
- 注册中心不感知门禁；证据绑定 `content_digest = sha256(zip)`，同内容 + 同 dataset 不重跑（digest 级缓存）
- **流量收口**：页面与 CLI 统一走 `:3001`（nginx 反代 `/gate-api/`、`/build-api/`、`/app-api/`），3002/8300/8310 仅 Docker 网络内可达，安全组无需新增规则
- **统一对话入口**：页面所有对话走 `POST /gate-api/v1/agent/chat`——gate-service 做意图路由（create 转发 skill-build-agent，其余跑流水线），SSE 事件透传/复用；nginx `/gate-api/`、`/build-api/` 两段 location 均按 SSE 配置（`proxy_buffering off` + 300s，照抄 OntoMind nginx.conf:494-505 的写法），`/build-api/` 保留用于技能库查询与直连调试

## 2. 技能创建（skill-build-agent 容器，openjiuwen DeepAgent）

机制（已逐文件核实 tools\skill-build-agent\python 全部源码）：

- **纯对话创建**：`POST /api/skill-build-agent/chat`，请求体 `{message, history:[{role,content}]}`；服务端**无状态单轮**——不存会话，历史由客户端全量传（服务端取末 20 条、每条截 2000 字符拼成扁平 query）
- **Agent 能力边界**：每请求新建 DeepAgent，tools/skills 空、max_iterations=1、文件读写权限全 deny——不能落盘，产出只存在于对话文本
- **产出协议**：回答中 ` ```skill-md ` 代码块 = SKILL.md 全文；` ```skill-file `（首行 `path: xxx` + 正文）= 附件文件
- **SSE 事件**：`phase{name,status,detail}` / `token{content}`（假流式 4 字符/10ms）/ `result{answer}` / `done` / `error{error}` / `hb` 心跳（>15s 无事件）；120 秒 deadline
- **系统提示词**（prompt.py）：OntoMind 规范——frontmatter 仅 name/description（含 YAML 格式硬规则）+ 正文 5 章节（适用场景与触发条件/输入与前置条件/执行流程/完成标准/异常处理与安全边界）+ 输出前自检清单
- **技能库（AI Harbor skill 知识实测盘点，不止 4 个）**：openjiuwen SkillScanner 只读扫描挂载目录 `/app/skills/custom`、`/app/skills/official`，`GET /skills` 暴露给平台。OntoMind 本地 skill 知识存量：**真实技能 5 个**——`customer-risk-review`（6 个版本快照）、`customer-risk-review-e2e`、`customer-insight`、`gov-doc-format-checker`（2 版本）、`knowledge-base-search`（2 版本）；另有 5 个 `autofix-qa-mtzaXXXX` 为 QA 自动化夹具（seed 时排除）；配套 eval-datasets 11 个、skill-checks 52 条检查记录、GEPA 进化任务记录。首次部署把这 5 个技能 seed 进 `/app/skills/custom`（从 skill-check-versions 各取最新 digest），后续从注册中心同步已发布 skill
- 部署：python:3.11-slim + `openjiuwen==0.1.17.post1`（PyPI 公网）+ fastapi 0.116.1 + uvicorn；端口 8300（容器网络内）；env：`LLM_API_BASE/LLM_API_KEY/LLM_MODEL`（qwen 通路）、`SKILLS_CUSTOM_DIR/SKILLS_OFFICIAL_DIR`

整合适配（gate-service 承担草稿落库，替代 OntoMind 的 knowledge-builder drafts）：

| 端点 | 说明 |
|---|---|
| POST /v1/drafts | `{name, markdown, files:[{path,content}]}` → 落 `/data/drafts/<id>/`，返回 draft_id |
| GET /v1/drafts（列表）/ GET、PUT、DELETE /v1/drafts/:id | 草稿管理 |
| POST /v1/drafts/:id/zip | 服务端打包 → 返回 zip（检查扫描/测评可直接对草稿跑，不必手动下载） |

gate/eval/evolve 的入参支持 `draft_id` 或 multipart 上传 zip 二选一。**发布仍走 CLI**（`skw publish`，门禁前置）——Web 页创建完的草稿点「去发布」时提示用 `skw publish`，边界清晰。

统一入口适配：创建对话统一经 gate-service `POST /v1/agent/chat` 管道转发到 build-agent（**build-agent 源码零改动**，事件协议原样透传，仅多一层意图路由）；`GET /build-api/api/skill-build-agent/skills` 供页面展示技能库（「一系列 skill」）。

## 3. 技能检查扫描（basic 五项静态检查，秒级无 LLM）

| stage_id | 内容 | 来源 |
|---|---|---|
| skill-package | SKILL.md 存在、frontmatter 可解析、正文非空、references/ 引用文件存在 | OntoMind skill-package |
| skill-lint | name 规范（`^[a-z0-9][a-z0-9-]*$` ≤64）、description ≤1024 且非 TODO 占位、与目录名一致 | skw validate + OntoMind skill-lint |
| supply-chain-security | 外部 URL 清单、危险命令模式（curl \| sh、rm -rf、eval(）、越权路径（/etc、~/.ssh） | OntoMind supply-chain-security |
| credential-scan | 凭据正则：sk- 开头 key、AK/SK 对、`password=`、BEGIN PRIVATE KEY、bearer token 形态 | OntoMind credential-scan |
| prompt-injection-check | "ignore previous/忽略以上指令/系统提示"类注入模式、隐藏指令块（HTML 注释、零宽字符） | OntoMind prompt-injection-check |

## 4. 技能测评（runtime，真实 LLM 用例驱动）

| stage_id | 用例 kind | 判定 | 阈值 |
|---|---|---|---|
| trigger-evaluation | TRIGGER_POSITIVE / TRIGGER_NEGATIVE / BOUNDARY | judge 判断"该输入下该 skill 是否应被触发"，逐例对错 | trigger_accuracy ≥ 0.9 |
| task-evaluation | TASK | SKILL.md 作 system + case.input 作 user 跑 qwen；断言 = keywords/regex/required_tools/forbidden_tools 合取 + LLM judge（语义×0.5 + 工具×0.2 + 质量×0.3 ≥ 0.7，judge 不可用时降级规则合取并标 judge_missing） | pass_rate ≥ 0.9 |

- 用例集 `evals/dataset.yaml`（scope: SMOKE/REGRESSION/RELEASE；kind 四类；expected_keywords/expected_regex/required_tools/forbidden_tools/llm_judge_rubric/holdout 标记）
- 阈值按 scope 服务端默认（SMOKE 0.6 / REGRESSION 0.8 / RELEASE 0.9），dataset 顶层可覆盖
- 证据同时绑定 dataset digest——用例变了必须重跑
- LLM 不可达 → judge 环节失败记 fail，RELEASE 不通过（错误给到端点/鉴权层诊断）；规则断言全过且 judge 缺失时 stage 标 `degraded`，仅 SMOKE 放行

## 5. 技能进化（多轮反思迭代 + 复评消噪，OntoMind GEPA/REFLECT/baseline 思路）

```
base eval（dataset 全量）
  ├─ 全过 → 结论"无需进化"
  └─ 有失败 → base 消噪（OntoMind run_baseline 思路）：失败 case 复评 2 次多数投票
       判定翻转的抖动 case 不进入修复目标；定论作为全程对比锚点
  反思迭代轮（max_rounds 默认 3，REFLECT 三态 continue/stop）：
       输入 = SKILL.md 全文 + 失败 case{输入/期望/实际输出} + holdout 清单
       qwen 产出 = 结构化诊断（哪节缺内容/描述模糊/示例误导）+ 重写 SKILL.md
       约束：只允许改正文与 description；name、frontmatter 其余字段不变；adopt 时 version patch+1
     candidate eval：同一 dataset 复测（同模型保证可比）；与原判定翻转的 case 复评消噪
     逐 case 对比（锚定 base 定论）：fixed[]（原失败→过）/ regressed[]（原过→败）/ still_failing[]
     采纳标准：fixed == 全部原失败 ∧ regressed == 空 ∧ name 未被改动
       （holdout = 原通过用例集，回归一票否决）
       ├─ 满足 → "建议采纳" + 新旧 diff + 证据，停止
       ├─ 本轮零修复 → REFLECT stop，拒绝（继续轮大概率重复）
       └─ 有修复但有剩余 → 候选为新基线，下一轮只修剩余失败
采纳：skw evolve adopt <job_id>（或 Web 页确认）→ 覆盖本地 SKILL.md（自动备份到 evals/history/）→ 重走检查扫描/测评 → 发布
```

对齐 OntoMind 语义：对比标准天然含"原失败 case 必须全修复"（feedback-resolution 关闭条件）。

## 6. gate-service API 契约

鉴权：`Authorization: Bearer <GATE_TOKEN>`；响应 `{code, msg, data}`；上传 multipart。

| 方法/路径 | 请求 | 响应/语义 |
|---|---|---|
| POST /v1/agent/chat | `{message, history[], draft_id?, mode?}`（SSE） | **统一对话入口**：意图路由 create/validate/eval/evolve/adopt；create → 管道转发 build-agent（事件透传），其余 → 本地跑流水线、结果以 card 事件回 |
| POST /v1/drafts | `{name, markdown, files[]}` | 创建草稿（技能创建产出落库） |
| GET/PUT/DELETE /v1/drafts/:id | — | 草稿管理 |
| POST /v1/drafts/:id/zip | — | 草稿打包下载/供门禁引用 |
| POST /v1/gate/run | draft_id 或 multipart `file`(zip)+`dataset`(yaml) + `level` | 技能检查扫描（basic）+ 技能测评（runtime）编排；runtime 转异步返回 run_id |
| GET /v1/gate/runs/:id | — | `{status, stages[], content_digest, dataset_digest, evidence_id}` |
| POST /v1/eval/run | 同上 | 单独重跑测评 |
| POST /v1/evolve/run | 同上 + `max_rounds` | 异步 job_id |
| GET /v1/evolve/jobs/:id、POST .../adopt | — | 进度/对比报告/采纳（adopt 签发候选版 evidence 引用） |
| GET /v1/evidence/:ns/:name/:digest | — | `{released, gate_run_id, signed_at}` —— publish 前置校验 |
| GET /v1/healthz | — | 含 llm 探测状态 |

统一对话 SSE 事件（`/v1/agent/chat`）：`phase{name,status,detail}` 进度 / `token{content}` 文本流 / `card{type,payload}` 结构化卡片（stage 表、测评分与逐 case、进化对比、草稿已保存）/ `result` / `done` / `error` / `hb` 心跳。create 模式事件与 skill-build-agent 原生协议对齐（透传）；流水线模式复用同名事件。

意图路由实现（gate-service 内，约 30 行）：qwen 单次分类调用（flash，提示词给四类意图 + 当前 draft_id 上下文），返回 `{intent}` JSON；分类失败兜底 create（对话永不卡死）。前端快捷芯片可强制 `mode` 绕过路由；每轮回复卡片头部显示识别出的意图，可一键改跑。

证据链 `/data` 布局：`runs/{gate,eval,evolve}/<id>.json` + `evidence/<ns>/<name>/<digest>.json` + `drafts/<id>/`；tmp 解包现场跑完即删。

publish 门禁语义：`skw publish` → 查 evidence → 无则自动补跑 gate（release 级）→ 拿证据再上传注册中心；zip 改一个字节 digest 变，必须重跑。"强制"落在 CLI 侧（注册中心不可改），单机个人使用可接受，已知边界。

## 7. CLI 变更（skw v0.3.0）

| 命令 | 行为 |
|---|---|
| `skw dataset init/validate` | 生成/校验 evals/dataset.yaml |
| `skw gate [dir] [--level release]` | 上传跑检查扫描+测评，打印阶段表；证据落服务器 |
| `skw eval [dir]` | 调 gate-service（保留 `--local` mock 离线模式） |
| `skw evolve [dir] [--rounds N]` / `skw evolve adopt <job_id>` | 发起进化/采纳（覆盖前自动备份） |
| `skw publish [dir]` | 前置 evidence 校验/自动补跑 gate；其余契约不变 |

config：`~/.skw/config.json` 增加 `gateUrl`（`http://<SERVER_IP>:3001/gate-api`）、`gateToken`；env `GATE_URL/GATE_TOKEN` 优先。

## 8. 代码结构

```
gate-service/（Node 24 ESM，零框架，与 workbench 同风格）
├── src/
│   ├── server.js / auth.js / store.js（JSON 原子写）/ pack.js（解包+digest+清理）
│   ├── orchestrator.js（统一对话入口：意图路由 + create 转发 build-agent / 流水线编排出 card）
│   ├── stages/basic.js（五项检查）/ stages/runtime.js（测评编排）
│   ├── llm.js（OpenAI 兼容客户端 + 启动探测 A/B）/ judge.js（触发判定+三维权评分）
│   └── evolve.js（反思→重写→对比→结论）
└── package.json / Dockerfile（node:24-alpine，--max-old-space-size=256）

skill-build-agent/（直接复用 OntoMind 源码 tools\skill-build-agent\python，不改逻辑）
└── Dockerfile（python:3.11-slim，pip 装 requirements.txt，仅改 LLM env 默认值）
```

## 9. 部署清单

1. **无需新增安全组规则**：全部流量收口 3001；gate(3002)/build-agent(8300) 仅容器网络内
2. `deploy/gate-compose.yml`：gate-service + skill-build-agent 两个容器，加入 skillhub compose 网络；卷 `gate_data:/data`（含 drafts 与 skills）；env：`GATE_TOKEN`、两服务的 `LLM_*`（.env，不进 git）、`SKILLS_CUSTOM_DIR/SKILLS_OFFICIAL_DIR`（custom 由 seed 初始化：`deploy/seed/skills-custom/` 打包 5 个存量技能，取各自最新 digest 内容，排除 `autofix-qa-*` 夹具）
3. LLM 通路探测（已确认服务器可出公网）：容器内 curl `maas.qianwenaiapi.com/compatible-mode/v1/chat/completions` + QWEN_KEY 实测（qwen3.7-flash，兜底 qwen-plus）；结果写 healthz 与部署记录；不通则需用户提供替代端点（服务器上无 ai-harbor 内网网关）
4. 定制 Web 镜像：本地 pnpm build dist → 上传服务器 → `FROM ghcr.io/iflytek/skillhub-web:v0.2.26` 叠加构建 `skillhub-web-custom:v0.2.26.1` → compose override 指过去
5. 内存预算：gate-service ~60-100MB + build-agent ~120-180MB（python slim + openjiuwen）；余量 1.5G+swap 够；Java 若 OOM 加 `-Xmx512m`
6. nginx 新增两段 location：`/gate-api/ → http://gate:3002/`（去前缀；统一对话入口，SSE：`proxy_buffering off`、`proxy_read_timeout 300s`、`Connection ""`）、`/build-api/ → http://skill-build-agent:8300/`（技能库查询与直连调试，同 SSE 配置）

## 10. 里程碑与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| G1 | 两个新容器部署 + gate-service 五项检查 + 证据落盘 | skw gate 跑通 demo-skill；故意放 key 的样本被 credential-scan 拦截 |
| G2 | skill-build-agent 接 qwen + 对话创建链路 + 技能库 seed | /build-api/ SSE 全事件序列正常；对话产出 skill-md 块可提取落草稿；`GET /skills` 返回 5 个 seed 技能（无 autofix-qa-*） |
| G3 | 技能测评（trigger/task + judge） | SMOKE dataset 真实跑分；llm 挂掉时明确报错不静默放行 |
| G4 | publish 强制门禁 + digest 证据绑定 | 改一字节必须重跑；未过门禁 publish 被拦 |
| G5 | 技能进化（多轮反思迭代 + 复评消噪）+ adopt | 带失败 case：进化后原失败全修复、holdout 零回归，diff 可读 |
| G6 | 前端「技能构建」页（对话式统一界面）+ 定制镜像部署 | :3001 导航「首页 → 技能构建 → 发布」；对话框可发起四类任务、意图路由正确、卡片/工作区展示正确；亮暗主题/响应式与站内一致 |
| G7 | 端到端 | 页面单对话框完成 创建→检查扫描→测评→进化修复→采纳，CLI `skw publish` 后注册中心可见 |
| G8 | 首批数据 | 5 个 seed 技能走 检查扫描→测评→`skw publish` 全链路，注册中心/市场可见真实数据 |
| G9 | 技能应用（§13）| :3001 一级导航「技能应用」（套件与控制台之间）；预置 skill-app-agent 自动安装 stock-lookup；容器内 SSE 全事件（phase/skill_load/tool/token/result）；浏览器 E2E 对话「查贵州茅台股价」真实跑脚本；卸载后 Agent 不再可加载 |

## 11. 风险与边界

- **CLI 侧强制边界**：不走 skw 的直接 POST 可绕过门禁——单机个人使用可接受
- **意图误判**：自由文本被路由到错误任务——快捷芯片强制指定模式 + 回复卡片显示识别意图可一键改跑 + 分类失败兜底 create（三重兜底，对话永不卡死）
- **judge 稳定性**：qwen3.7-flash 偶发格式漂移；judge 强制 JSON schema + 失败重试 1 次，再失败降级规则断言（仅 SMOKE 放行）
- **maas key 是镜像站 key**：余额/限流不可控；探测失败切 B 通路；都不通则 release 永不签发，错误信息指明
- **对话创建 120s 上限**：沿用 agent 原生 deadline；复杂需求分多轮（协议本就无状态多轮）
- **进化重写质量**：只改正文约束靠 prompt + adopt 前人工 diff 双保险；本地备份可回滚
- **openjiuwen 依赖**：PyPI 公网包 0.1.17.post1 版本锁定；服务器拉取失败则走 pip 国内镜像
- **Web 定制升级成本**：上游升级需重做叠加（改动集中 6 个文件）；版本固定策略下可接受

## 12. 前端「技能构建」页（:3001 站点内嵌）

**方式**：基于 v0.2.26 的 web 源码做**最小定制**（版本固定，改动集中 6 个文件）。前端栈已查明：React 19 + TypeScript + Vite + TanStack Router/Query + Tailwind 3.4 + shadcn 风格组件 + lucide-react + sonner；黑白极简设计令牌（`--primary: #202020`、`--radius: 10px`、淡蓝 accent hover、暗色主题全套）。仓库自带 react-dropzone（上传）与 react-diff-viewer-continued（diff）直接复用。

### 12.1 源码改动清单（6 个文件）

| 文件 | 改动 |
|---|---|
| `web/src/app/layout.tsx` | `HEADER_NAV` 在 `nav.landing`（首页）与 `nav.publish`（发布）之间插入 `{ label: t('nav.build'), to: '/build', auth: true }` |
| `web/src/app/router.tsx` | 注册 `/build` 路由（lazy） |
| `web/src/i18n/locales/{zh,en,ko,ru}.json` | `nav.build`：技能构建 / Skill Builder / 기술 빌드 / Конструктор навыков |
| `web/src/pages/build.tsx` | 新页面（对话式统一界面见 12.2，交互协议照抄 OntoMind SkillBuildWorkbench） |
| `web/src/api/gateClient.ts` | 新增：统一 SSE 客户端（`/gate-api/v1/agent/chat` 主入口 + `/build-api/.../skills` 技能库查询；SSE 解析参照 OntoMind skillBuildAgentClient.ts:113-192） |
| `web/nginx.conf.template` | 新增 `/gate-api/`、`/build-api/` 两段 location |

### 12.2 页面信息架构（对话式统一界面：左对话流 + 右工作区）

**交互范式**：整页就是一个对话工作台——所有任务默认从对话框发起，底层 agent（skill-build-agent）+ skill 库支撑，结构化结果以卡片回在对话流里，完整明细在右侧工作区展开。四项功能保留用户命名，作为输入框上方的快捷芯片（点击=强制指定任务，绕过意图识别）。布局参照 OntoMind SkillBuilderV2（左聊天 + 右预览），风格用站内设计令牌（shadcn 组件 + `--primary/--radius` + 暗色主题）。

1. **对话主区（左侧，占 ~55% 宽）**
   - 输入框（Enter 发送，Markdown 渲染气泡）+ 快捷芯片：`技能创建` / `技能检查扫描` / `技能测评` / `技能进化`（点击自动填充指令并强制 mode）
   - 请求：`POST /gate-api/v1/agent/chat`，体 `{message, history, draft_id, mode?}`；history 前端维护（含当前草稿 `<skill_context>` 注入，照抄 useSkillChat.ts:62-77）
   - 流式渲染：`token` 打字机增量；`phase` 任务进度条（如 解包→五项检查→trigger→task）；`card` 结构化卡片（草稿已保存 / 检查五项表 / 测评分数+逐 case / 进化对比+diff 摘要）；`hb` 心跳；两 chunk 间隔 120s 断流报错且保留已收内容（abort 同 OntoMind 处理）
   - 意图路由：gate-service qwen 单次分类；卡片头部显示识别意图（如「已识别：技能检查扫描」），一键改跑；分类失败兜底 create
   - 参考技能库：输入区上方「技能库」入口，抽屉列出 `GET /build-api/api/skill-build-agent/skills` 返回的 seed 技能（首批 5 个存量 + 后续发布同步），点击即把该技能名插入对话作为创建参考
2. **右侧工作区（占 ~45% 宽，Tab：草稿 / 检查 / 测评 / 进化）**
   - 草稿：SKILL.md 预览+编辑（frontmatter 剥离渲染）、附件列表；```skill-md → SKILL.md、```skill-file（首行 path:）→ 附件提取（正则照抄 useSkillChat.ts:55-79）；已有内容时「新版提案」并排对比 Modal（SkillBuilderV2.tsx:502-506 同款）；保存前端校验（name 规范/5 章节）→ `POST /gate-api/v1/drafts` → 对话流出「已保存」卡；本地 IndexedDB 700ms 防抖备份
   - 检查：五项 stage 卡片（skill-package / skill-lint / supply-chain / credential / injection），失败展开明细，证据 ID + digest 一键复制；历史 run 列表
   - 测评：dataset YAML 查看/校验（react-dropzone 上传）、scope 与阈值展示、trigger_accuracy / pass_rate 分数条 vs 阈值、逐 case 断言命中 + judge 三维评分明细、degraded 黄标、单 case 试跑
   - 进化：fixed / regressed / still_failing 三色对比表；新旧 SKILL.md diff（react-diff-viewer-continued，跟随暗色主题）；下载候选 + 「确认采纳」（服务端记录 adopted）
3. **创建 → 发布衔接**：草稿检查扫描全过后，对话流提示 `skw publish`（发布仍走 CLI，边界不变）；页面请求全部同源（`/gate-api`、`/build-api`），GATE_TOKEN 登录后存 localStorage

### 12.3 构建与部署

```
本地：cd skillhub-src/web && pnpm install --frozen-lockfile && pnpm build   # Node 22 + corepack
上传：dist/ + docker-entrypoint.d/* + analytics-config.awk → 服务器 ~/skillhub/build/
服务器：docker build -f web.custom.Dockerfile -t skillhub-web-custom:v0.2.26.1 ~/skillhub/build/
        compose override：web.image → 定制镜像；gate/build-agent 并入同一网络
```

- 验收：`:3001` 头部导航「首页 → **技能构建** → 发布」；对话创建→检查→测评→进化全流程可用；亮暗主题与移动端与站内一致

## 13. 技能应用（G9：DeepAgent 试运行环境）

**目标**：用户可把注册中心技能安装到预置 OpenJiuWen DeepAgent，真实试运行 agent+skill 组合，完成功能体验与验证。一级导航「技能应用」位于「技能套件」与「控制台」之间。

### 13.1 架构

- **skill-app-agent 容器**（Python :8310，`deploy/gate-compose.yml`，skillhub 网络）：openjiuwen 0.1.17.post1 `create_deep_agent`；workspace 的 `skills` 节点为 **per-fp 技能库副本**（copytree 而非软链——Workspace init 会向所有节点目录写 `.workspace` 标记，软链会污染真实技能树并使指纹漂移）。SkillUseRail 扫的是 `workspace.get_node_path("skills")` 而非 `skills=` 参数；内置 `skill_tool` 直读 `/data/skills`（sys_operation 预注册 `sandbox_root=[/data/workspace, /data/skills]` 放行沙箱，file_guard 技能库只读）
- **框架锁 patch**（agent_factory 导入时执行）：openjiuwen 0.1.17.post1 的 `HybridAsyncReadWriteLock` 在子 task 中 acquire、当前协程 release，与新版 filelock 的 task 归属检查冲突 → 每次写文件报 "Cannot release a lock ... not held by this task"、锁永不释放、同路径第二次写永久挂起。monkeypatch `_acquire_file/_release_file` 改为当前协程直接 await（轮询重试语义不变），多轮对话死锁根除
- **工具**：`run_skill_script`（openjiuwen @tool）——子进程执行技能包内 Python 脚本，cwd=当前指纹 workspace（ContextVar 注入），60s 超时、输出截断 8000 字符、路径 resolve 防穿越；permissions 全 deny 默认，仅放行 run_skill_script / skill_tool / todo_*
- **指纹缓存**：技能目录树 (relpath,size,mtime) sha256（**忽略隐藏文件**，防框架内部写入引起指纹漂移）→ agent 实例缓存；install/uninstall 后指纹变化自动重建；**每个指纹独立 workspace 子目录 `/data/workspace/run-<fp8>`**（openjiuwen 文件锁被已初始化 agent 持久持有，路径重叠会死锁），重建时清理更早的 run-* 目录（保留当前与上一个）
- **事件桥**：AppEventRail（DeepAgentRail.after_tool_call）拦截 `skill_tool`（→ skill_load 事件）与 `run_skill_script`（→ tool 事件），经 ContextVar 注入 emit 回调推 SSE
- **鉴权**：Bearer GATE_TOKEN（复用「技能构建」页 localStorage `gateToken`；未配置 503）
- **预置**：`AUTO_INSTALL_SKILLS=personal/stock-lookup` 启动时 best-effort 安装（3 次重试）

### 13.2 API 契约（`/app-api/v1`，nginx SSE 配置同 gate/build）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/healthz` | 免鉴权：registry 探测 / llm 配置 / 已安装数 |
| GET | `/v1/agent` | agent 档案 + 已安装技能列表 |
| GET | `/v1/skills/registry?q=&limit=` | 注册中心搜索（匿名公开技能，信封兼容） |
| POST | `/v1/skills/install` | `{namespace, slug}` → resolve→download→zip 安全解压（拒绝绝对路径/穿越，缺 SKILL.md 回滚）；重复 409 |
| POST | `/v1/skills/uninstall` | `{name}`（`^[a-z0-9][a-z0-9._-]*$` 白名单） |
| POST | `/v1/chat` | SSE `{session_id?, message, history?}`；事件 phase / token / skill_load / tool / result / error / hb / done；300s agent 超时 + 15s 心跳 + 120s 前端断流保护 |
| POST | `/v1/session/reset` | `{session_id}` |

### 13.3 前端「技能应用」页

- 左列：Agent 档案卡（名称/描述/model/capabilities chips + 已安装技能 chips 卸载）+ 注册中心搜索安装列表（已安装标记）
- 右列：对话试运行（Markdown 流式 + phase chips + 过程时间线：加载技能/执行脚本/错误红条 + 示例指令 chips + 新会话）
- 文件：`appClient.ts`（新增）、`applications.tsx`（新增）、`layout.tsx` nav 插入、`router.tsx`、i18n×4（技能应用 / Skill Apps / 스킬 앱 / Приложения навыков）、vite proxy `/app-api`
- 市场详情页「安装到 Agent」按钮（`install-for-agent-button.tsx`）：与技能应用共用同一 install API，一键真实安装到 skill-app-agent（成功提示版本并引导到「技能应用」试运行；409 视为已安装；非安全版本号禁用），不再只是复制提示词
- 部署：镜像 v0.2.26.2；nginx 模板加 `/app-api/` location 块；**定制 image + `GATE_API_UPSTREAM`/`BUILD_AGENT_UPSTREAM`/`APP_API_UPSTREAM` 已固化写入服务器 `~/skillhub/deploy/compose.release.yml` 的 web 服务**（overlay 仅作本地参考——无 overlay 的 compose 操作会把 web 回退到原生镜像，曾致 /app-api 全挂）

### 13.4 边界

- 仅支持纯标准库脚本技能（MVP）；会话连续性依赖前端全量 history（服务端 Session 仅框架态）；技能包 zip 根级散文件与多层嵌套均可（统一顶层目录自动剥离）
