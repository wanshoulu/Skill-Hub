// stages/basic.js — 五项静态检查（秒级，无 LLM）
// stage: skill-package / skill-lint / supply-chain-security / credential-scan / prompt-injection-check
import matter from 'gray-matter';

// Anthropic Agent Skills 规范：小写字母/数字开头和结尾，中间允许连字符，禁止连续连字符和尾部连字符
const NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NAME_MAX = 64;
const DESC_MAX = 1024;
const COMPAT_MAX = 500;
const BODY_LINE_WARN = 500;

// 允许的 frontmatter 字段（规范白名单）
const ALLOWED_META = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

// 每条 finding: {level: fail|warn, rule, message, file}
// 占位样例豁免：文档里写 "sk-xxxxxxxx" / "your-api-key" 这类不算命中
const PLACEHOLDER = /(example|sample|placeholder|your[-_a-z]|x{5,}|<your[^>]*>|\$\{)/i;

// 可疑隧道/临时域名（数据外传常见通道）
const SUSPICIOUS_DOMAINS = /(ngrok\.io|bore\.pub|serveo\.net|localtunnel\.me|loophole\.site|pinggy\.io|tunnelto\.dev)/i;

// Unicode 同形字/混淆字符检测（西里尔、希腊等视觉相似字符）
const CONFUSABLE_RE = /[\u0400-\u04FF\u0500-\u052F\u0370-\u03FF\u1F00-\u1FFF\u0590-\u05FF\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function scanText(stageId, text, file, rules, findings) {
  for (const line of text.split('\n')) {
    for (const { re, level, rule, message, skip } of rules) {
      const m = line.match(re);
      if (!m) continue;
      // 豁免只看命中段（整行含 example 等词不该连坐漏报）
      if (skip?.test(m[0])) continue;
      findings.push({ stage: stageId, level, rule, message: `${message}：\`${m[0].slice(0, 80)}\``, file });
    }
  }
}

export function runBasic({ name, files }) {
  const stages = [];
  const t0 = Date.now();

  const skillMd = files.find((f) => f.path === 'SKILL.md');
  let meta = null;
  let body = '';

  // ── 1. skill-package ──────────────────────────────────────────
  const pkgFindings = [];
  if (!skillMd) {
    pkgFindings.push({ level: 'fail', rule: 'skill-md-missing', message: '缺少 SKILL.md', file: '' });
  } else {
    try {
      const parsed = matter(skillMd.text || '');
      meta = parsed.data || {};
      body = parsed.content || '';
      if (!body.trim()) {
        pkgFindings.push({ level: 'fail', rule: 'empty-body', message: 'SKILL.md 正文为空', file: 'SKILL.md' });
      }
    } catch (e) {
      pkgFindings.push({ level: 'fail', rule: 'frontmatter-broken', message: `frontmatter 解析失败：${e.message}`, file: 'SKILL.md' });
    }
    // references/ 引用存在性（正文里链接/提及的 references/xxx 必须真实存在于包内）
    const paths = new Set(files.map((f) => f.path));
    const refs = body.match(/references\/[\w\-./]+\.[\w]+/g) || [];
    for (const ref of new Set(refs)) {
      if (!paths.has(ref)) {
        pkgFindings.push({ level: 'fail', rule: 'missing-reference', message: `正文引用的文件不存在：${ref}`, file: 'SKILL.md' });
      }
    }
  }
  stages.push(stage('skill-package', '技能包完整性', pkgFindings));

  // ── 2. skill-lint ─────────────────────────────────────────────
  const lintFindings = [];
  if (meta) {
    const nm = meta.name;
    if (nm == null || nm === '') {
      lintFindings.push({ level: 'fail', rule: 'name-missing', message: 'frontmatter 缺少 name', file: 'SKILL.md' });
    } else if (typeof nm !== 'string' || !NAME_RE.test(nm)) {
      lintFindings.push({ level: 'fail', rule: 'name-invalid', message: `name 非法 "${nm}"（须小写字母/数字开头和结尾，仅含小写字母/数字/连字符）`, file: 'SKILL.md' });
    } else {
      if (nm.includes('--')) {
        lintFindings.push({ level: 'fail', rule: 'name-consecutive-hyphens', message: `name 含连续连字符 "${nm}"`, file: 'SKILL.md' });
      }
      if (nm.length > NAME_MAX) {
        lintFindings.push({ level: 'fail', rule: 'name-too-long', message: `name 超过 ${NAME_MAX} 字符`, file: 'SKILL.md' });
      }
    }
    if (typeof nm === 'string' && name && nm !== name) {
      lintFindings.push({ level: 'fail', rule: 'name-mismatch', message: `name "${nm}" 与目录/草稿名 "${name}" 不一致`, file: 'SKILL.md' });
    }
    const desc = meta.description;
    if (desc == null || desc === '') {
      lintFindings.push({ level: 'fail', rule: 'desc-missing', message: 'frontmatter 缺少 description（agent 靠它决定是否加载）', file: 'SKILL.md' });
    } else if (typeof desc === 'string') {
      if (desc.length > DESC_MAX) {
        lintFindings.push({ level: 'fail', rule: 'desc-too-long', message: `description 超过 ${DESC_MAX} 字符（当前 ${desc.length}）`, file: 'SKILL.md' });
      }
      if (/TODO/i.test(desc)) {
        lintFindings.push({ level: 'warn', rule: 'desc-placeholder', message: 'description 仍是模板占位文案（含 TODO）', file: 'SKILL.md' });
      }
    }
    // 可选字段规范验证
    if (meta.compatibility != null) {
      if (typeof meta.compatibility !== 'string') {
        lintFindings.push({ level: 'warn', rule: 'compatibility-invalid', message: 'compatibility 应为字符串', file: 'SKILL.md' });
      } else if (meta.compatibility.length > COMPAT_MAX) {
        lintFindings.push({ level: 'fail', rule: 'compatibility-too-long', message: `compatibility 超过 ${COMPAT_MAX} 字符（当前 ${meta.compatibility.length}）`, file: 'SKILL.md' });
      }
    }
    if (meta.license != null && typeof meta.license !== 'string') {
      lintFindings.push({ level: 'warn', rule: 'license-invalid', message: 'license 应为字符串', file: 'SKILL.md' });
    }
    if (meta.metadata != null && (typeof meta.metadata !== 'object' || Array.isArray(meta.metadata))) {
      lintFindings.push({ level: 'warn', rule: 'metadata-invalid', message: 'metadata 应为键值对映射（对象）', file: 'SKILL.md' });
    }
    if (meta['allowed-tools'] != null && typeof meta['allowed-tools'] !== 'string') {
      lintFindings.push({ level: 'warn', rule: 'allowed-tools-invalid', message: 'allowed-tools 应为空格分隔的字符串', file: 'SKILL.md' });
    }
    // 未知字段告警（规范白名单）
    for (const key of Object.keys(meta)) {
      if (!ALLOWED_META.has(key)) {
        lintFindings.push({ level: 'warn', rule: 'unknown-field', message: `frontmatter 含未知字段 "${key}"（规范仅允许 ${[...ALLOWED_META].join(', ')}）`, file: 'SKILL.md' });
      }
    }
  }
  // 正文行数告警（Anthropic 建议 ≤500 行）
  if (body) {
    const lineCount = body.split('\n').length;
    if (lineCount > BODY_LINE_WARN) {
      lintFindings.push({ level: 'warn', rule: 'body-too-long', message: `SKILL.md 正文 ${lineCount} 行（建议 ≤${BODY_LINE_WARN} 行，提升 agent 加载效率）`, file: 'SKILL.md' });
    }
  }
  stages.push(stage('skill-lint', '技能规范检查', lintFindings));

  // ── 3. supply-chain-security ──────────────────────────────────
  const secFindings = [];
  const secRules = [
    { re: /curl[^|]*\|\s*(ba)?sh|wget[^|]*\|\s*(ba)?sh/i, level: 'fail', rule: 'pipe-to-shell', message: '存在「下载并直接执行」模式' },
    { re: /\brm\s+-rf\s+[~\/]/, level: 'fail', rule: 'rm-rf-root', message: '存在 rm -rf 对根/家目录的危险操作' },
    { re: /\beval\s*\(/, level: 'fail', rule: 'eval-usage', message: '存在 eval() 动态执行' },
    { re: /\bchmod\s+777\b/, level: 'warn', rule: 'chmod-777', message: '存在 chmod 777 过宽权限' },
    { re: /(^|[\s"'])\/etc\/[\w\-./]*/, level: 'fail', rule: 'etc-path', message: '引用系统敏感路径 /etc/' },
    { re: /~\/\.ssh|~\/\.aws|~\/\.gnupg|\/root\//, level: 'fail', rule: 'private-path', message: '引用用户私密路径（.ssh/.aws 等）' },
    { re: /\bsudo\s+\w+/, level: 'warn', rule: 'sudo-usage', message: '存在 sudo 提权命令' },
    // base64 混淆执行（Snyk 恶意技能常见模式）
    { re: /base64\s+(?:-d|--decode)[^|]*\|?\s*(eval|sh|bash|python|exec)/i, level: 'fail', rule: 'base64-obfuscation', message: '存在 base64 解码后执行（混淆代码常见模式）' },
    { re: /echo\s+["'][A-Za-z0-9+/=]{40,}["']\s*\|\s*(base64\s+-d|base64\s+--decode)/i, level: 'fail', rule: 'base64-pipe-exec', message: '存在 base64 编码串管道解码执行' },
    // 持久化注入（修改全局 agent 配置文件）
    { re: /CLAUDE\.md|\.claude\/settings|\.clinerules|\.cursorrules|~\/\.config\/claude/i, level: 'fail', rule: 'persistence-injection', message: '尝试修改 agent 全局配置文件（持久化注入）' },
    // 密码保护 ZIP（规避自动扫描）
    { re: /\bunzip\s+-P\s+\S+/i, level: 'fail', rule: 'password-protected-zip', message: '存在密码保护 ZIP 解压（可能用于规避扫描）' },
    // 动态导入/远程代码加载
    { re: /\b(?:import|require|exec|execSync)\s*\(\s*https?:\/\//i, level: 'fail', rule: 'remote-code-load', message: '存在远程 URL 动态加载代码' },
    { re: /\b(?:__import__|importlib\.import_module)\s*\(\s*['"]https?:\/\//i, level: 'fail', rule: 'remote-import-python', message: '存在远程 URL 动态导入 Python 模块' },
    // 系统服务篡改（Snyk 发现的持久化后门模式）
    { re: /systemctl\s+(?:edit|mask|unmask|daemon-reload)/i, level: 'warn', rule: 'systemctl-tamper', message: '存在 systemctl 服务篡改操作' },
    // 反弹 shell 模式
    { re: /(?:bash|sh|zsh)\s+-[il].*?>.*?(?:\/dev\/tcp|\/dev\/udp|\s&)/i, level: 'fail', rule: 'reverse-shell', message: '疑似反弹 shell 模式' },
    { re: /\bnc\s+-[a-z]*[le][a-z]*\s+\S+\s+\d+/i, level: 'fail', rule: 'netcat-listener', message: '疑似 netcat 监听/连接（反弹 shell 常用）' },
    // 未固定依赖（requirements.txt 中使用 >= 而非 ==）
    { re: /^[^#]*[a-zA-Z0-9_-]+\s*>=\s*\d/i, level: 'warn', rule: 'unpinned-dependency', message: '存在未固定版本依赖（建议使用 == 固定版本）' },
  ];
  for (const f of files) {
    if (!f.text) continue;
    scanText('supply-chain-security', f.text, f.path, secRules, secFindings);
    const urls = f.text.match(/https?:\/\/[^\s)"'`>]+/g) || [];
    for (const u of [...new Set(urls)].slice(0, 20)) {
      if (SUSPICIOUS_DOMAINS.test(u)) {
        secFindings.push({ level: 'fail', rule: 'suspicious-tunnel-domain', message: `可疑隧道/临时域名（数据外传风险）：${u}`, file: f.path });
      } else {
        secFindings.push({ level: 'warn', rule: 'external-url', message: `外部 URL：${u}`, file: f.path });
      }
    }
  }
  stages.push(stage('supply-chain-security', '供应链安全', secFindings));

  // ── 4. credential-scan ────────────────────────────────────────
  const credFindings = [];
  const credRules = [
    { re: /\bsk-[A-Za-z0-9_-]{20,}/, level: 'fail', rule: 'api-key', message: '疑似 API Key（sk- 形态）', skip: PLACEHOLDER },
    { re: /\bAKIA[0-9A-Z]{16}\b/, level: 'fail', rule: 'aws-key', message: '疑似 AWS AccessKey', skip: PLACEHOLDER },
    { re: /(?:access[_-]?key|secret[_-]?key)["'\s:=]{1,3}["']?[\w\-]{16,}/i, level: 'fail', rule: 'ak-sk-pair', message: '疑似 AK/SK 硬编码', skip: PLACEHOLDER },
    { re: /password\s*[=:]\s*["']?[^\s"'{}]{6,}/i, level: 'fail', rule: 'password', message: '疑似明文密码', skip: PLACEHOLDER },
    { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, level: 'fail', rule: 'private-key', message: '包含私钥块' },
    { re: /\bbearer\s+[A-Za-z0-9\-._~+/]{20,}/i, level: 'fail', rule: 'bearer-token', message: '疑似 Bearer Token', skip: PLACEHOLDER },
    { re: /\b(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}\b/, level: 'fail', rule: 'github-token', message: '疑似 GitHub Token', skip: PLACEHOLDER },
    { re: /\beyJ[A-Za-z0-9\-_]{20,}\.[A-Za-z0-9\-_]{10,}\./, level: 'fail', rule: 'jwt', message: '疑似 JWT Token', skip: PLACEHOLDER },
    // Google API Key（AIza 开头）
    { re: /\bAIza[0-9A-Za-z\-_]{35}\b/, level: 'fail', rule: 'google-api-key', message: '疑似 Google API Key', skip: PLACEHOLDER },
    // Slack Bot/User Token（xox[bp]- 开头）
    { re: /\bxox[bp]-[0-9A-Za-z-]{10,}/, level: 'fail', rule: 'slack-token', message: '疑似 Slack Token', skip: PLACEHOLDER },
    // Stripe Secret Key（sk_live_ / sk_test_ 开头，与 api-key 的 sk- 区分）
    { re: /\bsk_(?:live|test)_[0-9a-zA-Z]{20,}/, level: 'fail', rule: 'stripe-key', message: '疑似 Stripe Secret Key', skip: PLACEHOLDER },
    // Tencent Cloud SecretId（AKID 开头）
    { re: /\bAKID[0-9A-Za-z]{32,}\b/, level: 'fail', rule: 'tencent-key', message: '疑似腾讯云 SecretId', skip: PLACEHOLDER },
    // Twilio API Key（SK 开头 32 位）
    { re: /\bSK[0-9a-fA-F]{32}\b/, level: 'fail', rule: 'twilio-key', message: '疑似 Twilio API Key', skip: PLACEHOLDER },
    // 连接字符串中的密码
    { re: /(?:mongodb|postgres|mysql|redis):\/\/[^\s:@]+:[^\s@/]{6,}@/i, level: 'fail', rule: 'connection-string-creds', message: '数据库连接字符串含内嵌密码', skip: PLACEHOLDER },
  ];
  for (const f of files) {
    if (!f.text) continue;
    scanText('credential-scan', f.text, f.path, credRules, credFindings);
  }
  stages.push(stage('credential-scan', '凭据泄露扫描', credFindings));

  // ── 5. prompt-injection-check ─────────────────────────────────
  const injFindings = [];
  const injRules = [
    { re: /ignore\s+(?:all\s+)?(?:previous|prior|above)|disregard\s+(?:the\s+)?above/i, level: 'fail', rule: 'injection-en', message: '疑似英文注入指令（ignore previous）' },
    { re: /忽略(?:以上|之前|上面)(?:的)?(?:所有)?指令|无视(?:以上|之前)指令|不要遵守(?:以上|之前)指令/, level: 'fail', rule: 'injection-zh', message: '疑似中文注入指令' },
    { re: /(?:你现在是|act as|pretend to be)\s*.{0,30}(?:开发者模式|DAN|越狱)/i, level: 'fail', rule: 'jailbreak', message: '疑似越狱/角色劫持指令' },
    { re: /system\s*prompt(?![a-z])/i, level: 'warn', rule: 'system-prompt-mention', message: '提及 system prompt（人工复核）' },
    { re: /<!--[\s\S]{0,200}?(?:指令|instruction|prompt|忽略|ignore)[\s\S]{0,200}?-->/i, level: 'fail', rule: 'hidden-html', message: 'HTML 注释中隐藏指令' },
    // 系统消息冒充（伪造 system/assistant 角色标记）
    { re: /<\|?(?:im_start|system|assistant)\|?>/i, level: 'fail', rule: 'role-impersonation', message: '疑似角色标记冒充（伪造 system/assistant 消息）' },
    // base64 编码注入指令（解码后含注入关键词）
    { re: /\b(?:base64|atob)\s*\(?\s*['"]([A-Za-z0-9+/=]{20,})['"]/, level: 'warn', rule: 'base64-encoded-content', message: '存在 base64 编码内容（可能隐藏注入指令）' },
    // 数据外传指令（要求发送本地文件到远程）
    { re: /(?:发送|上传|传|send|upload|transfer|exfiltrat)[\s\S]{0,40}(?:credentials|密钥|\.env|\.ssh|密码|token|secret)/i, level: 'fail', rule: 'data-exfiltration-instruction', message: '疑似数据外传指令（要求发送敏感文件/凭据）' },
    // 凭证收集指令（要求用户粘贴密钥）
    { re: /(?:请?\s*(?:提供|输入|粘贴|告诉我)|please\s*(?:provide|enter|paste|share))[\s\S]{0,30}(?:api[_\s-]?key|密码|password|token|secret|密钥)/i, level: 'warn', rule: 'credential-harvesting', message: '疑似凭证收集（要求用户提供密钥/密码）' },
  ];
  for (const f of files) {
    if (!f.text) continue;
    // 整段规则（跨行 HTML 注释）单独扫
    for (const { re, level, rule, message } of injRules) {
      if (rule === 'hidden-html') continue;
      const matches = f.text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
      if (matches) {
        for (const m of matches) injFindings.push({ level, rule, message: `${message}：\`${m.slice(0, 60)}\``, file: f.path });
      }
    }
    const hidden = f.text.match(/<!--[\s\S]*?-->/g) || [];
    for (const h of hidden) {
      if (/(?:指令|instruction|prompt|忽略|ignore)/i.test(h)) {
        injFindings.push({ level: 'fail', rule: 'hidden-html', message: 'HTML 注释中隐藏指令', file: f.path });
      }
    }
    // 零宽字符（正文夹带不可见指令的常用手段）；文件开头 BOM 除外
    const zw = f.text.slice(f.text.charCodeAt(0) === 0xfeff ? 1 : 0).match(/[\u200B\u200C\u200D\u2060\uFEFF]/g);
    if (zw?.length) {
      injFindings.push({ level: 'fail', rule: 'zero-width-chars', message: `检测到 ${zw.length} 个零宽字符（隐藏内容）`, file: f.path });
    }
    // Unicode 同形字/混淆字符检测（视觉相似字符可能用于伪装注入指令）
    if (f.path === 'SKILL.md' && CONFUSABLE_RE.test(f.text)) {
      const confusableChars = f.text.match(new RegExp(CONFUSABLE_RE.source, 'g'));
      const sample = confusableChars ? [...new Set(confusableChars.map((c) => c.charCodeAt(0).toString(16)))].slice(0, 5) : [];
      injFindings.push({ level: 'warn', rule: 'confusable-chars', message: `检测到 ${confusableChars?.length || 0} 个 Unicode 同形/混淆字符（U+${sample.join(', U+')}），可能用于伪装指令`, file: f.path });
    }
    // Unicode 标签块（U+E0000-E007F ASCII 走私）
    const tagBlocks = f.text.match(/[\uE0000-\uE007F]/g);
    if (tagBlocks?.length) {
      injFindings.push({ level: 'fail', rule: 'unicode-tag-block', message: `检测到 ${tagBlocks.length} 个 Unicode 标签块字符（ASCII 走私）`, file: f.path });
    }
  }
  // YAML 结构化注入检测（frontmatter 中的别名、合并键、!!binary 等）
  if (skillMd?.text) {
    const raw = skillMd.text;
    // YAML 别名注入（&anchor / *alias 可用于绕过字段检查）
    if (/&\w+\s/.test(raw) && /\*\w+/.test(raw)) {
      injFindings.push({ level: 'warn', rule: 'yaml-alias', message: 'frontmatter 含 YAML 别名引用（&anchor/*alias），可能用于绕过字段检查', file: 'SKILL.md' });
    }
    // YAML 合并键（<<: 可合并多个映射，绕过字段验证）
    if (/<<:\s/.test(raw)) {
      injFindings.push({ level: 'warn', rule: 'yaml-merge-key', message: 'frontmatter 含 YAML 合并键（<<:），可能用于绕过字段验证', file: 'SKILL.md' });
    }
    // YAML !!binary 解码（base64 编码的二进制数据，可隐藏注入内容）
    if (/!!binary\s/.test(raw)) {
      injFindings.push({ level: 'fail', rule: 'yaml-binary-tag', message: 'frontmatter 含 !!binary 标签（可隐藏编码内容，需人工复核）', file: 'SKILL.md' });
    }
  }
  stages.push(stage('prompt-injection-check', '提示注入检测', injFindings));

  // 总时长
  const dur = Date.now() - t0;
  for (const s of stages) s.duration_ms = dur;
  return stages;
}

function stage(id, title, findings) {
  const hasFail = findings.some((f) => f.level === 'fail');
  return {
    stage_id: id,
    title,
    kind: 'basic',
    status: hasFail ? 'fail' : findings.length ? 'warn' : 'pass',
    findings,
    started_at: new Date().toISOString(),
  };
}
