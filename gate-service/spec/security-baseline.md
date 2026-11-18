# SkillHub Skill 安全基线（creator 红线）

> 版本：1.0 ｜ 面向：creator（skill-build-agent）与人工作者。
> 来源：`gate-service/src/stages/basic.js` 七项静态检查规则导出，rule_id 一一对应。
> 用途：**生成前约束**（对话创建时注入，事前规避）+ **生成后拦截**（gate 扫描，事后兜底）。
> 级别含义：fail=一票否决；warn=放行但要求关注。样例占位符（`<your-api-key>`、`example`、`xxxxx`）不触发凭据规则。

## A. 供应链安全（supply-chain-security）

### fail（一票否决）

| rule_id | 红线 | 正确做法 |
|---|---|---|
| `pipe-to-shell` | 不得"下载并直接执行"（curl/wget … \| sh/bash） | 下载后校验（哈希/签名）再运行，或用包管理器安装 |
| `rm-rf-root` | 不得 `rm -rf` 作用于 `/`、`~` 等根/家目录 | 精确删除本技能工作目录内生成的文件 |
| `eval-usage` | 不得 `eval()` 动态执行拼接代码 | 显式调用具名函数 |
| `etc-path` | 不得引用 `/etc/` 下文件（passwd/shadow 等） | 配置经用户显式传入 |
| `private-path` | 不得引用 `~/.ssh`、`~/.aws`、`~/.gnupg`、`/root/` | 凭据走环境变量/密钥管理服务 |
| `base64-obfuscation` | 不得 base64 解码后执行（`base64 -d … \| sh`） | 交付明文可审计代码 |
| `base64-pipe-exec` | 不得长 base64 串管道解码执行 | 同上 |
| `persistence-injection` | 不得修改 agent 全局配置（CLAUDE.md、.claude/settings、.cursorrules 等） | 不做任何持久化 |
| `password-protected-zip` | 不得 `unzip -P` 密码保护 zip（规避扫描） | 明文交付，密钥另行管理 |
| `remote-code-load` | 不得运行时从远程 URL 动态加载执行代码 | 依赖随包固定 |
| `remote-import-python` | 不得 `__import__`/`importlib` 远程 URL 模块 | 依赖 `==` 固定并预装 |
| `reverse-shell` | 不得出现反弹 shell（`bash -i > /dev/tcp/…`） | 正常输出结果 |
| `netcat-listener` | 不得 `nc -le`/`nc -l` 监听后门 | — |
| `suspicious-tunnel-domain` | 不得引用隧道/临时域名（ngrok.io、bore.pub、serveo.net 等） | 使用正式服务端点 |

### warn（关注）

| rule_id | 要求 | 正确做法 |
|---|---|---|
| `chmod-777` | 避免 `chmod 777` 过宽权限 | 按最小权限 `chmod 750/755` |
| `sudo-usage` | 避免 `sudo` 提权 | 说明所需权限，交由用户执行 |
| `systemctl-tamper` | 避免 `systemctl edit/mask/daemon-reload` | 不触碰宿主服务 |
| `unpinned-dependency` | 依赖固定版本（禁止 `>=`） | `pkg==1.2.3` / npm 精确版本 |
| `external-url` | 外部 URL 列入清单供评审 | 给出可信域名并说明用途 |

## B. 凭据扫描（credential-scan）——全部 fail

任何真实形态的密钥/口令不得出现在 SKILL.md、脚本或样例中：

| rule_id | 模式 |
|---|---|
| `api-key` | `sk-` 开头 API Key |
| `aws-key` | `AKIA` 开头 AWS AccessKey |
| `ak-sk-pair` | access_key/secret_key 硬编码 |
| `password` | `password=`/`passwd=`/`pwd=` 明文口令 |
| `private-key` | `BEGIN PRIVATE KEY` 私钥块 |
| `bearer-token` | `Bearer eyJ…`/长 token |
| `github-token` | `ghp_`/`gho_`/`ghu_`/`ghs_`/`github_pat_` |
| `jwt` | `eyJ………` JWT 形态 |
| `google-api-key` | `AIza` 开头 |
| `google-oauth-token` | `ya29.` 开头 OAuth 访问令牌 |
| `gcp-service-account` | `"type":"service_account"` 服务账号 JSON |
| `slack-token` | `xoxb-`/`xoxp-`/`xapp-1-` |
| `stripe-key` | `sk_live_`/`sk_test_` |
| `stripe-webhook-secret` | `whsec_` 开头 Webhook 签名密钥 |
| `tencent-key` | `AKID` 开头腾讯云 SecretId |
| `aliyun-key` | `LTAI` 开头阿里云 AccessKey |
| `twilio-key` | `SK`+32 位 hex |
| `gitlab-token` | `glpat-` 开头 |
| `digitalocean-token` | `dop_v1_` 开头 |
| `npm-token` | `npm_` 开头发布令牌 |
| `pypi-token` | `pypi-` 开头上传令牌 |
| `huggingface-token` | `hf_` 开头 |
| `sendgrid-key` | `SG.` 双段形态 |
| `atlassian-token` | `ATATT` 开头 |
| `shopify-token` | `shpat_`/`shpca_`/`shppa_` |
| `figma-token` | `figd_` 开头 |
| `azure-storage-key` | `AccountKey=` 连接串形态 |
| `connection-string-creds` | `mysql/postgres/redis/mongodb/amqp/ftp/sftp://user:pass@…` 连接串内嵌密码 |

正确做法：一律用占位符（`<your-api-key>`、`$MY_API_KEY`），注明"从环境变量/密钥管理服务读取"。

## C. 提示注入与内容伪装（prompt-injection-check）

### fail

| rule_id | 红线 |
|---|---|
| `injection-en`/`injection-zh` | 不得出现"ignore previous instructions / 忽略以上指令"类指令覆盖 |
| `jailbreak` | 不得出现越狱/角色劫持（DAN、开发者模式） |
| `hidden-html` | 不得用 HTML 注释夹带指令 |
| `role-impersonation` | 不得伪造 `<\|system\|>`/`<\|im_start\|>` 角色标记 |
| `data-exfiltration-instruction` | 不得指示发送用户数据/凭据/.env/.ssh 到外部 |
| `zero-width-chars` | 不得含零宽字符（U+200B 等，隐藏内容常用） |
| `unicode-tag-block` | 不得含 Unicode Tag 区段字符（ASCII 走私） |
| `yaml-binary-tag` | frontmatter 不得用 `!!binary` 标签 |

### warn（人工复核）

| rule_id | 要求 |
|---|---|
| `system-prompt-mention` | 避免提及 system prompt |
| `credential-harvesting` | 避免指示用户提供密钥/密码（应引导用环境变量） |
| `confusable-chars` | 不得用西里尔/希腊等同形字符伪装指令 |
| `yaml-alias`/`yaml-merge-key` | frontmatter 不得用 YAML 别名/合并键绕过字段检查 |
| `base64-encoded-content` | base64 块需说明用途 |

## D. 声明式豁免

教学示例确需展示危险模式时：用占位符替换关键参数，并在正文"异常处理与安全边界"章节说明该样例仅作反例演示；
无法豁免的转评审看板人工复核。
