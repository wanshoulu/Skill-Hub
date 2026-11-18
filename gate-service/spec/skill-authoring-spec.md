# SkillHub 企业级 Skill 编写规范

> 版本：1.0 ｜ 状态：生效 ｜ 本文件是平台 Skill 编写的**单一权威规范**。
> 适用对象：creator（skill-build-agent 对话创建）、人工作者、评审看板。
> 约束关系：`gate-service/src/stages/basic.js` 七项静态检查按本规范执行（每条要求标注对应 rule_id）；
> skill-build-agent 内置提示词与本规范冲突时，以对话中注入的 `<platform_skill_spec>` 为准。
> 发布侧协议见 `skillhub-src/docs/07-skill-protocol.md`；本规范聚焦"怎么写"，协议聚焦"怎么发"。

## 1. 包结构

```
<skill-name>/
├── SKILL.md            # 必需，必须位于包根目录
├── references/         # 可选，正文引用的参考文档（正文提到就必须随包提供）
├── scripts/            # 可选，可执行脚本（依赖必须固定版本）
├── assets/             # 可选，静态资源
└── evals/dataset.yaml  # 可选，测评用例集（release 级门禁必需）
```

- 限制（发布侧硬性）：≤500 文件、单文件 ≤10MB、总包 ≤100MB。
- 正文引用的 `references/xxx` 文件必须真实存在于包内 → rule `missing-reference`（fail）。

## 2. frontmatter

### 2.1 必填字段

| 字段 | 类型 | 规则 | 检查 rule |
|---|---|---|---|
| `name` | string | 小写字母/数字开头和结尾，仅含小写字母/数字/连字符，禁止连续连字符，≤64 字符（`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`） | `name-missing`/`name-invalid`/`name-consecutive-hyphens`/`name-too-long`（fail） |
| `name` | — | 必须与目录名/草稿名一致 | `name-mismatch`（fail） |
| `name` | — | 不得使用过于通用的名称（helper/utils/tools/common/general/misc 等，缺乏区分度） | `SEM-013`（warn） |
| `description` | string | ≤1024 字符；必须包含触发条件（"Use when…/适用于…"）；用第三人称（不得出现 I/you）；不得是 TODO 占位 | `desc-missing`（fail）、`desc-too-long`（fail）、`SEM-001`/`SEM-005`/`desc-placeholder`（warn） |

### 2.2 可选字段（白名单，其余字段一律告警 `unknown-field`）

| 字段 | 类型 | 规则 | 检查 rule |
|---|---|---|---|
| `license` | string | SPDX 标识符（如 `Apache-2.0`、`MIT`） | `license-invalid`（warn） |
| `compatibility` | string | 运行环境要求说明，≤500 字符 | `compatibility-invalid`（warn）/`compatibility-too-long`（fail） |
| `metadata` | object | 企业治理键值对，推荐键见 §5 | `metadata-invalid`（warn） |
| `allowed-tools` | string | 空格分隔的工具白名单 | `allowed-tools-invalid`（warn） |

> 注意：creator 内置提示词曾要求"frontmatter 仅 name/description"。以本规范为准：**允许且鼓励**补齐
> `license` 与 `metadata`（企业发布建议），技能检查不会因此告警。

### 2.3 mcp_tools（平台扩展）

技能依赖 MCP 工具时，在 frontmatter 声明（由平台在对话创建时自动装配，手写格式如下）：

```yaml
mcp_tools:
  - server: <server_name>
    tool: <tool_name>
```

## 3. 正文结构（五章节，必须齐全）

| # | 章节 | 要求 |
|---|---|---|
| 1 | 适用场景与触发条件 | 明确"何时用/何时不用"（SEM-006：定义范围的同时给出排除项） |
| 2 | 输入与前置条件 | 输入格式、依赖环境、需要的凭据形态（占位符，绝不出现真实凭据） |
| 3 | 执行流程 | 步骤化、编号明确；条件分支必须有默认/兜底分支（EXPR-005） |
| 4 | 完成标准 | 可判定的验收条件，用确定性语言（always/never/must，EXPR-001） |
| 5 | 异常处理与安全边界 | 异常路径、失败行为、禁止事项、涉及敏感数据时的合规措施（§5） |

- 包完整性（fail）：缺少 SKILL.md（`skill-md-missing`）、正文为空（`empty-body`）、frontmatter 解析失败（`frontmatter-broken`）、正文引用的 references/ 文件不存在（`missing-reference`）。
- 正文 ≤500 行（`body-too-long` warn，Anthropic Agent Skills 加载效率建议）；详细内容放 references/。
- 元规则悖论（EXPR-004）与无条件遵循所有用户指令（EXPR-008）为 fail；矛盾指令（EXPR-002）、
  always 与例外共存（EXPR-003）、条件分支无默认（EXPR-005）、消极指令无正面替代（EXPR-007）、
  模糊指令过多（EXPR-001）为 warn。

## 4. 脚本与依赖（写技能时就要守，详见 security-baseline.md）

- 依赖用 `==` 固定版本，禁止 `>=`（`unpinned-dependency` warn）。
- 禁止"下载并直接执行"（`curl|sh`）、`eval()`、反弹 shell、netcat 监听、base64 解码执行、
  修改 agent 全局配置文件、密码保护 zip（以上均 fail）。
- 禁止引用 `/etc/`、`~/.ssh`、`~/.aws`、`/root/`（fail）；`sudo`、`chmod 777`、`systemctl` 篡改为 warn。

## 5. 企业治理（metadata 推荐键，COMP/OPS 系列）

```yaml
metadata:
  version: 1.0.0                # OPS-001：semver，缺省 warn
  owner: data-platform-team     # OPS-002：负责人/归属
  data_classification: internal # COMP-001：public/internal/confidential/restricted
  model_version: qwen3.7-flash  # COMP-009：可复现性（ISO 42001）
```

按内容触发的声明义务（warn）：涉及 PII 必须声明脱敏措施（COMP-002）；PHI 需 HIPAA 措施（COMP-003）；
持卡人数据需 PCI-DSS 措施（COMP-004）；企业部署需审计日志声明（COMP-005）与数据保留策略（COMP-006）；
高风险场景需人工审查声明（COMP-007，EU AI Act）；金融/健康/法律领域需免责声明（COMP-008）。

## 6. 检查与门禁

- `check` 级：§1-§4 七项静态检查（秒级，无 LLM）。创建对话保存草稿后自动执行。
- `release` 级：check 全部内容 + `evals/dataset.yaml` 真实用例测评（触发准确率 ≥0.9、任务通过率 ≥0.9）。
- 检查未通过 → 在「技能构建」页一键"按检查结果修复"（findings 携带 rule_id 回流 creator 重写）。
- 通过 release 级才签发发布证据（content_digest 绑定）。
