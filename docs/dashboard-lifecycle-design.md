# Skill 看板与全生命周期管理 — 调研对比与设计方案

日期：2026-11-17
状态：待评审（评审通过后开发）

## 1. 背景与目标

用户反馈两个问题：

1. **没有 skill 看板功能**：无法统计各 skill 的指标数据并可视化呈现；
2. **skill 全生命周期管理不全**：控制台需补齐。

目标：先充分调研业界对标产品，对比后产出设计方案，经确认后分期开发。

## 2. 业界调研对比

调研对象分三组共 9 个对标：经典包/插件市场（npm、PyPI、VS Code Marketplace）、AI 平台市场（Dify Marketplace、扣子 Coze、Hugging Face Hub）、工作流与 Agent 生态（n8n、Smithery、OpenAI GPT Store / Anthropic Agent Skills）。信息截至 2026-11-17，来源见附录。

### 2.1 指标看板体系对比

| 产品 | 核心计量指标 | 时间趋势 | 质量信号 | 榜单 | 发布者看板 |
|---|---|---|---|---|---|
| npm | downloads（tarball 拉取） | 包页周下载 + 版本近 7 天；API 按日返回（2015 年起） | 官方搜索按"热度+维护+质量"多维排序 | 无官方 Trending，靠搜索排序 | 包页公开指标，作者无独立后台 |
| PyPI | downloads（官方页 2016 年已移除，靠第三方 pypistats） | 第三方按日；官方 Stats API 仅 Top100 按体积 | 无评分体系 | 无下载榜 | 无官方发布者看板 |
| VS Code | downloads 与 installs 分开计数 | 发布者管理页 Acquisition Trend 曲线 | 评分 + 评论 | 首页 Trending this week/month | Azure DevOps 报表（浏览→获取转化率） |
| Dify | install（分发）与 invocation（调用）双口径 | 官方月度快照 | 安全等级 S/A/B/C 绑定版本，升级须重扫 | 需求指数（60% 调用 + 40% 安装百分位） | 市场页仅展示累计安装 |
| Coze | 调用次数（付费插件每小时统计，"每成功调用一次计一次使用"） | 应用作者有数据分析看板 | 官方/三方、免费/付费角标 | 商店分类 + 精选 | 插件作者看板无公开文档 |
| HF Hub | downloads = 近 30 天滚动，另有全量累计；likes | 无内置趋势图，第三方靠每日快照自建 | trendingScore 字段 | 全站排序：trending/downloads(30d)/likes | 指标 API 完全公开无鉴权 |
| n8n | 模板 views：totalViews（累计）/ recentViews（近期）双口径 | 双口径本身即趋势信号 | verified 徽章 + 人工模板审核 | 按浏览与编辑精选 | Creator Portal 可见浏览量 |
| Smithery | uses（经网关采集的使用次数） | Daily Sessions 趋势图 | 0-100 自动扫描分 + 厂商验证徽章 | 目录按 uses 排序 | server 页公开指标 |
| GPT Store / Anthropic Skills | GPT 曾有 engagement 看板（现随 GPT Store 退役收缩）；Anthropic Skills 无任何指标看板 | — | GPT 用户评分 + builder 域名验证 | Top Picks / Trending | Skills 生态无市场、无统计 |

**业界共识（看板）：**

1. **双口径分层**：分发量（install/download）≠ 使用量（use/invocation），两者分开统计与展示（Dify、Smithery、n8n、VS Code）；
2. **累计 + 时间趋势是标配**：按日趋势曲线（npm range API、VS Code Acquisition Trend、Smithery Daily Sessions）或滚动窗口（HF 近 30 天）；
3. **质量信号三来源叠加**：自动扫描分 + 人工审核徽章 + 用户评分；
4. **口径必须公示**：Dify 公开"调用数低估 2-5 倍"的偏差，PyPI 对口径断点发公告——避免"无分母的数字"；
5. **榜单按 use 排序可抑制刷 install**（Smithery 按 uses 排序的经验）。

### 2.2 生命周期管理对比

| 产品 | 软下架/弃用 | yank（撤回） | 硬删除 | 状态即 API 元数据 | 存量消费者保护 |
|---|---|---|---|---|---|
| npm | deprecate 包级/版本级，必带消息，可 undeprecate；unpublish 有 72h 政策与多重门禁 | — | unpublish 不可逆、版本号永久不可复用 | CLI 安装弃用包输出 `npm warn deprecated` | 弃用仅警告不阻断 |
| PyPI | archived 状态：禁新上传、移出搜索、**仍可安装** | yank/unyank 可逆、带原因，pip 装 yanked 版本报 WARNING | delete 不可逆（管理员也无法恢复） | PEP 792：archived/quarantined 下发 simple index，消费端自动感知 | yanked 精确匹配仍可装 |
| VS Code | Deprecate 可指向替代扩展，Unpublish 为软下架（保留统计） | — | Remove 不可逆、需输入扩展名确认 | 弃用扩展灰色删除线 + 三种迁移提示 | Unpublished 停止下载但保留统计 |
| Dify | 平台可 suspended/removed；工作空间级卸载 | — | 移除权限仅限 owner/admin | 安全等级随 API 下发 | 下架仅阻断新安装，已装实例本地继续运行 |
| Coze | 下架/停用/移除/删除四级粒度 | — | 删除资产不可恢复且全量失效 | 状态含审核中；发布与上架分离 | 已安装用户仍可正常使用 |
| HF | 弃用无官方状态（模型卡 YAML 横幅，民间做法） | — | 删除/转私有后 404 | downloads 等 API 公开 | gated reset 邮件通知 |
| n8n | 节点 deprecated（存量继续运行+迁移提示）→ removed（工作流直接失败）两级退役 | — | — | 退役分级对运行时可见 | deprecated 不破坏存量 |
| GPT Store | 迁移期原 GPT 转只读，设明确退役日 | — | — | — | 未迁移 GPT 可用到退役日 |
| Anthropic Skills | API /v1/skills 提供版本可寻址 CRUD，删除须先删全部版本 | — | ≤8MB 约束、name 强校验 | 版本 latest 指针 | 仅安全提示 |

**业界共识（生命周期）：**

1. **软操作优先于硬删除**：可逆链条 deprecate（可恢复）→ yank（可恢复）→ archive/unpublish（温和下架）→ delete（多重门禁 + 确认输入）；
2. **版本级与包级操作分离**（npm/PyPI 均如此）；
3. **下架不破坏存量消费者**：阻断新发现/新安装，存量继续可用并给迁移提示（Dify/Coze/n8n/GPT Store 一致）；
4. **状态变更下发到 API/CLI 元数据**，消费端自动渲染警告（PEP 792、npm warn）；
5. **弃用必须带结构化迁移去向**（原因 + 替代物指引），并从搜索移除/降权。

## 3. SkillHub 现状盘点（证据）

### 3.1 看板现状

- **前端**：dashboard 首页仅 6 张静态导航卡片，无任何数据（`web/src/app/pages/dashboard.tsx:99-134`）；`web/package.json` 无任何图表库；无 stats 组件；
- **Server**：无任何统计/指标 API。最接近的是 `GovernanceController /summary`（治理工作台计数）；
- **已有数据资产**（可直接利用）：
  - `skill.download_count`（migration V2）+ `skill_version_stats.download_count`（V14），在下载路径原子递增（`SkillDownloadService.java:182-183`）；
  - `skill` 表 star_count、rating_avg/rating_count；各实体 created_at/published_at/submitted_at/reviewed_at 时间戳；`audit_log` 全治理操作留痕（V1）；
  - 9 类业务事件（发布/下载/评审/晋升/状态/可见性/yank）已埋点，但仅 OTLP HTTP 导出、不落库（`BusinessEventMapper.java:13-15`），当前 `BUSINESS_LOGS_ENABLED=false`；
  - Micrometer 指标走 actuator，非业务 API。
- **关键缺口**：无下载事件明细表（只有累计值，算不了日趋势）；无聚合统计 API；无图表库；dashboard 无数据。

### 3.2 生命周期现状

权威契约：上游 `skillhub-src/docs/14-skill-lifecycle.md`（容器状态 ACTIVE/ARCHIVED + hidden 治理覆盖层；版本状态 DRAFT/SCANNING/SCAN_FAILED/UPLOADED/PENDING_REVIEW/PUBLISHED/REJECTED/YANKED）。

**已实现**：发布链（DRAFT/UPLOADED→PENDING_REVIEW→PUBLISHED/REJECTED）、withdraw-review、rerelease、yank（含 latest 指针修正，docs/14 §4.8）、删除版本（限未发布版本）、归档/取消归档、隐藏/恢复（治理覆盖层）、可见性独立调整（走审核）、promotion 复制式晋升与撤销。

**缺口**（docs/14 与代码双重确认）：

| 缺口 | 证据 |
|---|---|
| yank 无恢复操作（unyank） | docs/14 L128："yank：…没有对应的恢复发布操作" |
| 无弃用标记（deprecate） | 无 DEPRECATED 状态/字段，市场页无弃用警告 |
| ARCHIVED=禁止下载 | `SkillDownloadService.java:326-330` 强制 status==ACTIVE；搜索只索引 ACTIVE（`PostgresSearchRebuildService.java:97`）。与 PyPI"归档仍可装"不同，归档即不可用 |
| 无技能级"温和下架" | 下架=ARCHIVED（连存量下载一起断），无"停止新发现但存量可用"的中间态 |
| 控制台无生命周期总览 | 各状态数量、待办队列无汇总页面 |
| 版本操作入口分散 | yank 仅在详情页，my-skills 列表无版本操作 |

## 4. 差距矩阵（业界共识 × 现状 → 行动项）

| 业界共识 | SkillHub 现状 | 行动项 | 分期 |
|---|---|---|---|
| 累计+日趋势看板 | 只有累计值、无看板 | 快照差分采集 + 看板页面 | 一期 |
| 平台级统计与榜单 | 无 | 总览 KPI + Top 榜 | 一期 |
| 生命周期总览/待办 | 无 | /dashboard/lifecycle 总览页 | 一期 |
| yank 可逆 | 缺 | unyank | 二期 |
| 弃用标记带迁移去向 | 缺 | deprecate 治理覆盖层 + 替代指引 | 二期 |
| 状态即 API/CLI 元数据 | 部分（事件有埋点） | resolve 响应带 deprecated，skw 安装 warn | 二期 |
| 温和下架（存量可用） | 缺 | deprecate 承担该角色（警告不阻断），ARCHIVED 语义保持不变 | 二期 |
| 使用量（invocation）口径 | 无采集 | 暂不做（需 app-agent 埋点改造，价值/成本比低） | 不做 |
| UV/去重统计 | 无 | 不做（需事件明细表，二期后视需要） | 不做 |

## 5. 设计方案

### 5.1 看板（一期，零 Java 改动）

#### 5.1.1 指标数据来源 — 三条技术路线取舍

| 路线 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A. 前端聚合现有 API | 前端拉现有列表 API 现场计算 | 零后端改动 | 现有 API 有可见性过滤拿不到全量；无趋势数据源；每次刷新全量拉取 | **否决** |
| B. server 内建统计 | Java 加 download_event 明细表 + 聚合 API + 重建 server 镜像 | 最正统，可算精确日下载/UV | 必须改 Java + 重建 server 镜像（构建链路未验证，成本高、周期长）；上游契约同步成本 | 二期后视需要演进 |
| C. 旁路只读快照差分 | gate-service 新增 stats 模块：定时只读直查 postgres 累计值做快照，相邻快照差分出日趋势 | **零 Java 改动**；复用现有 gate 部署链路；下载计数本身由 server 原子维护、数据可信；趋势自上线起自动积累 | 趋势无历史回填；无 UV；下载口径为"分发次数"（含 CLI resolve/app-agent install 全部路径，同 npm 口径） | **推荐（一期）** |

选型依据：本项目"自研部分用 Node.js"约定 + 服务器资源紧张（3.6G 内存，并入现有 gate 容器零新增）+ server 镜像重建成本未验证（风险后置）。

#### 5.1.2 采集架构（路线 C 细化）

```
postgres(只读查询) ──每小时──> gate-service stats 模块 ──快照──> gate_data 卷(JSON)
                                     │
web 看板 <── /gate-api/v1/stats/* ────┘（nginx 已有 /gate-api/ 反代）
```

- **采集**（node 内置定时，每小时一次，单连接 + 超时保护，只读）：
  - `skill`：id、slug、namespace_id、status、visibility、download_count、star_count、rating_avg/count、created_at
  - `skill_version`：status、published_at（发布趋势、yanked/deprecated 列表）
  - `review_task` / `promotion_request`：PENDING 待办计数
- **存储**：JSON 快照按小时落 gate_data 卷，保留 90 天；日下载量 = 相邻日末快照 download_count 差分；内存中合并响应查询。
- **只读安全**：在 postgres 建 `readonly` 角色（仅 SELECT 权限），凭据进 gate 栈 `.env`（沿用 REGISTRY_TOKEN 先例）。
- **API**（挂 gate 路由，静态 token 校验，防外网裸调）：
  - `GET /gate-api/v1/stats/overview` — KPI 卡数据（技能总数/分布、今日/7日/累计下载、待评审数、待晋升数）
  - `GET /gate-api/v1/stats/trend?days=30` — 日下载量、日发布量序列
  - `GET /gate-api/v1/stats/skills` — 全技能指标表（累计/近7日下载、star、评分、版本数、最近发布）
  - `GET /gate-api/v1/stats/top` — Top 10 下载榜 / star 榜
  - `GET /gate-api/v1/stats/lifecycle` — 各状态技能/版本计数 + 待办清单（一期的生命周期总览数据源）
- **鉴权**：nginx overlay 注入 `X-Stats-Token`（env），gate 校验；前端经既有 `gateClient.ts` 调用。

#### 5.1.3 前端设计

- **图表库**：recharts（React 生态标准，~100KB gz，趋势折线/柱状/占比环图够用）；
- **`/dashboard` 首页改造**：6 张静态卡 → 数据总览（KPI 卡 + 近 30 天下载趋势折线 + 发布趋势柱状 + 状态/可见性分布环图 + 待评审/待晋升入口 + Top 10 榜）；
- **新增 `/dashboard/analytics`**：技能指标表（可排序：累计下载/近7日/star/评分）+ 单技能 30 天趋势下钻；
- **`my-skills` 列表增强**：加下载/star/评分列；
- 遵循上游前端规范：TanStack Query 管理服务端状态、复用既有 UI 组件与 i18n。

### 5.2 生命周期管理补齐

#### 5.2.1 unyank（二期，Java 改动）

- 端点：`POST /api/v1/skills/{ns}/{slug}/versions/{version}/unyank`；权限同 yank（owner / namespace ADMIN、OWNER；平台治理入口另校验平台权限）；
- 语义：`YANKED → PUBLISHED`；恢复 `downloadReady=true`；yank 留痕（yanked_at/by/reason）**不抹除**，另记一条审计（unyank 人、时间），学 PyPI yank/unyank 可逆但不擦历史；
- latest 指针：复用 docs/14 §4.8 的指针修正逻辑做反向重算（该版本为最新 PUBLISHED 时指回它）；
- 前端：skill-detail 的 yanked 版本行加"恢复"按钮（带原因确认框）；
- 契约同步：按上游规则（AGENTS.md + docs/14 §7），生命周期变化须"实现 + 测试 + docs/14 更新"三同步，形成我们 fork 的 patch 记录，便于后续 rebase 上游。

#### 5.2.2 deprecate（二期，Java 改动）

按业界共识设计为**治理覆盖层**（学 hidden 覆盖层 + PEP 792"状态即 API 元数据"），**不新增容器状态枚举**——ACTIVE/ARCHIVED 是容器状态，"弃用"是展示/分发层语义，避免侵入状态机：

- DB（migration V124+）：`skill` 表加 `deprecated boolean`、`deprecation_reason text`、`replacement_slug text`（可选替代技能指引）；
- 端点：`POST /api/v1/skills/{ns}/{slug}/deprecate`（body: reason 必填、replacement 可选）/ `undeprecate`；权限 owner / namespace ADMIN、OWNER；
- 消费端效果（对齐业界"下架不破坏存量"）：
  - 市场页：灰色删除线 + 黄色警告横幅（reason + 替代技能链接）——不阻断下载（存量消费者不破坏）；
  - 搜索：弃用技能移出搜索索引（同 npm 整包弃用即移出搜索）；
  - CLI：resolve/download API 响应带 `deprecated/reason/replacement` 字段，`skw install` 输出 `warn deprecated`（学 npm warn）——app-agent 同样可感知；
- 审计：deprecate/undeprecate 进 audit_log（沿用 ARCHIVE_SKILL 同款模式）。

#### 5.2.3 控制台生命周期总览页（一期，纯 web + stats API）

`/dashboard/lifecycle`：

- 状态计数卡：容器状态（ACTIVE/ARCHIVED/hidden）、版本状态（PUBLISHED/PENDING_REVIEW/YANKED/…）、可见性分布；
- 待办队列：待评审版本、待晋升审批、yanked 版本列表（二期起带"恢复"入口）、弃用技能列表（二期起）；
- 快捷操作：跳转对应管理页（评审队列/晋升管理/技能详情）。

#### 5.2.4 明确不做（避免范围蔓延）

- **跨命名空间转移**：promotion（复制式）+ 撤销已覆盖场景，真 transfer 价值低；
- **使用量（invocation）口径**：需改造 app-agent 运行期埋点，一期先上"分发口径"，口径在页面脚注公示（学 Dify）；
- **UV/去重、批量操作、评分分析、数据导出**：数据量级小，待真实需求出现再加。

## 6. 实施分期与验收标准

### 一期：看板 MVP + 生命周期总览（零 Java 改动）

改动面：gate-service（stats 模块 + pg 依赖）、web 前端（dashboard 改造 + analytics + lifecycle 页 + recharts）、gate 栈 .env、postgres 只读角色、web-custom 镜像升 tag。

验收标准：

- [ ] /dashboard 展示真实 KPI 与近 30 天下载/发布趋势（发布一个测试技能 + 执行数次下载后数据正确）；
- [ ] /dashboard/analytics 技能指标表可排序、单技能趋势下钻正确；
- [ ] /dashboard/lifecycle 状态计数与 DB 实际一致（人工 SQL 抽查 3 组）；
- [ ] stats API 无 token 访问返回 401；快照任务失败时看板显示"数据截至 xx 时间"而非空白；
- [ ] 未登录访问三个新页面仍被 nginx 门禁 302 /login。

### 二期：生命周期补齐（需重建 server 镜像）

前置：先做一次 server 镜像**空构建链路验证**（不改代码构建 v0.2.26，确认 Maven/Docker 构建可行 + 镜像构建→save→scp→load 流程），通过后才启动开发。

验收标准：

- [ ] unyank 后版本恢复 PUBLISHED、可下载、latest 指针正确；yank 历史留痕可查；
- [ ] deprecate 后市场页横幅警告、搜索不再出现、CLI/skw 安装输出 warn、替代技能链接可点；undeprecate 完全恢复；
- [ ] audit_log 含 deprecate/unyank 记录；
- [ ] docs/14 与测试同步更新（三同步），fork patch 清单登记。

## 7. 风险与待验证项

| 风险 | 缓解 |
|---|---|
| server 镜像本地构建链路未验证（Java 多模块 Maven 构建、镜像推送流程） | 二期启动前先跑空构建验证，失败则二期方案重评（降级选项：暂缓 deprecate，仅做 unyank 等最小改动） |
| gate-service 加 pg 依赖需重建 gate 容器 | 已有 gate 重建先例（G6），流程熟 |
| 快照趋势无历史回填 | 设计预期内，页面标注"趋势自 2026-11-xx 上线起" |
| fork 与上游版本演进冲突 | 生命周朽数据库改动集中在一个 migration（V124+），Java 改动登记 patch 清单 |
| postgres 直连凭据管理 | 只读角色 + gate 栈 .env（不进 git） |

## 附：主要调研来源

- npm：docs.npmjs.com/policies/unpublish、deprecating-and-undeprecating、github.com/npm/registry download-counts
- PyPI：docs.pypi.org yanking/project-management、PEP 592/PEP 792、blog.pypi.org（quarantine、status markers）
- VS Code：code.visualstudio.com publishing-extension、learn.microsoft.com Azure DevOps 报表
- Dify：marketplace.dify.ai、dify.ai/blog（Trust Is a Feature，2026-09）
- Coze：docs.coze.cn（create-plugin、guides_data、cozespace_create_skill）
- HF：huggingface.co/docs/hub（api、models-gated、repository）
- n8n：docs.n8n.io（community nodes、verification、deprecated-nodes）
- Smithery：smithery.ai/docs/build/publish、arcade.dev/blog（收购与关停公告）
- OpenAI：help.openai.com sharing-and-publishing-gpts（2026-11 更新）
- Anthropic：docs.claude.com agent-skills、claude.com/blog organization-skills、agentskills.io

## 附：SkillHub 现状关键代码锚点

- 下载计数原子递增：`server/skillhub-domain/.../skill/service/SkillDownloadService.java:182-183`
- 下载强制容器 ACTIVE：同文件 `:326-330`（assertPublishedAccessible）
- 搜索只索引 ACTIVE：`server/skillhub-search/.../PostgresSearchRebuildService.java:97`
- 归档/恢复/yank：`server/skillhub-domain/.../skill/service/SkillGovernanceService.java:137-146/143/370`
- 业务事件映射：`server/.../BusinessEventMapper.java:13-15`（仅 OTLP 导出，不落库）
- dashboard 静态卡片：`web/src/app/pages/dashboard.tsx:99-134`
- 生命周期契约：`skillhub-src/docs/14-skill-lifecycle.md`（L128 unyank 缺口）
