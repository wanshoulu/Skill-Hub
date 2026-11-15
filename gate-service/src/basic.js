// stages/basic.js — 五项静态检查（秒级，无 LLM）
// stage: skill-package / skill-lint / supply-chain-security / credential-scan / prompt-injection-check
import matter from 'gray-matter';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const NAME_MAX = 64;
const DESC_MAX = 1024;

// 每条 finding: {level: fail|warn, rule, message, file}
// 占位样例豁免：文档里写 "sk-xxxxxxxx" / "your-api-key" 这类不算命中
const PLACEHOLDER = /(example|sample|placeholder|your[-_a-z]|x{5,}|<your[^>]*>|\$\{)/i;

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
      lintFindings.push({ level: 'fail', rule: 'name-invalid', message: `name 非法 "${nm}"（只允许小写字母/数字/连字符开头）`, file: 'SKILL.md' });
    } else if (nm.length > NAME_MAX) {
      lintFindings.push({ level: 'fail', rule: 'name-too-long', message: `name 超过 ${NAME_MAX} 字符`, file: 'SKILL.md' });
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
  ];
  for (const f of files) {
    if (!f.text) continue;
    scanText('supply-chain-security', f.text, f.path, secRules, secFindings);
    const urls = f.text.match(/https?:\/\/[^\s)"'`>]+/g) || [];
    for (const u of [...new Set(urls)].slice(0, 20)) {
      secFindings.push({ level: 'warn', rule: 'external-url', message: `外部 URL：${u}`, file: f.path });
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
