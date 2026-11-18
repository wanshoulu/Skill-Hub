// spec.js — 企业级规范资产装载与 creator 注入
// 资产三件套：编写规范（skill-authoring-spec.md）+ 安全基线（security-baseline.md）+ 元模板库（templates/）
// 注入点：orchestrator.forwardCreate —— 规范/模板/安全要求在 creator 生成前即进入对话（事前约束），
// 生成后由 stages/basic.js 七项检查事后拦截（详见 spec/ 两份文档的 rule_id 对照）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'spec');
const SPEC_DIR = process.env.SPEC_DIR || DEFAULT_DIR;

let cache = null;

function readIfExists(file) {
  const p = path.join(SPEC_DIR, file);
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// 按资产 mtime 失效缓存（开发期改 spec 文件无需重启进程）；资产缺失不抛错（返回空串，创建流程不阻断）
function assetSignature() {
  const parts = [];
  for (const f of ['skill-authoring-spec.md', 'security-baseline.md']) {
    try { parts.push(`${f}:${fs.statSync(path.join(SPEC_DIR, f)).mtimeMs}`); } catch { parts.push(`${f}:0`); }
  }
  try {
    for (const f of fs.readdirSync(path.join(SPEC_DIR, 'templates'))) {
      try { parts.push(`${f}:${fs.statSync(path.join(SPEC_DIR, 'templates', f)).mtimeMs}`); } catch { parts.push(`${f}:0`); }
    }
  } catch { parts.push('templates:0'); }
  return parts.join('|');
}

export function specBundle() {
  const sig = assetSignature();
  if (!cache || cache._sig !== sig) {
    const templatesDir = path.join(SPEC_DIR, 'templates');
    let templates = [];
    try {
      templates = fs.readdirSync(templatesDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => ({ file: f, title: f.replace(/\.md$/, ''), content: fs.readFileSync(path.join(templatesDir, f), 'utf8') }));
    } catch {
      templates = [];
    }
    cache = {
      spec: readIfExists('skill-authoring-spec.md'),
      security: readIfExists('security-baseline.md'),
      templates,
      loaded_at: Date.now(),
      _sig: sig,
    };
  }
  return cache;
}

export function specReady() {
  const b = specBundle();
  return Boolean(b.spec && b.security);
}

// 基础模板骨架（注入用精简版；完整模板见 spec/templates/，含三档：basic/with-scripts/with-evals）
const TEMPLATE_SKELETON = [
  '```skill-md',
  '---',
  'name: <小写字母数字与连字符，如 monthly-sales-review>',
  'description: <一句话说明做什么，第三人称>。Use when <何时触发，如"用户要求汇总月度销售数据">',
  'metadata:',
  '  version: 0.1.0',
  '  owner: <团队或个人>',
  '  data_classification: internal',
  '  model_version: <所用模型版本，如 claude-sonnet-4-5>',
  '---',
  '',
  '# <技能标题>',
  '',
  '## 适用场景与触发条件',
  '- 适用：…',
  '- 不适用：…（必须给出排除项）',
  '',
  '## 输入与前置条件',
  '- 输入：…',
  '- 前置：…（凭据用 <your-api-key> 占位，从环境变量读取）',
  '',
  '## 执行流程',
  '1. …',
  '2. …',
  '条件处理：若 <异常条件>，则 <处理方式>；否则按上述流程继续。',
  '',
  '## 完成标准',
  '- <可判定验收条件>',
  '',
  '## 异常处理与安全边界',
  '- 异常路径：…',
  '- 每次执行输出处理摘要，便于审计；高风险输出必须经人工审查确认',
  '```',
].join('\n');

// 创建对话注入块。
// - 无草稿（首次创建）：注入完整规范 + 模板骨架（creator 对着规范和模板写）
// - 有草稿（迭代/修复）：注入精简规范 + 最近失败检查项（findings 闭环回流）
export function createSpecBlock({ hasDraft = false, failedRun = null } = {}) {
  if (!specReady()) return '';
  const compact = [
    '<platform_skill_spec priority="highest">',
    '（以下是 SkillHub 平台规范要点，与你内置规范冲突时以本规范为准）',
    '- frontmatter：必填 name（小写字母/数字与连字符，≤64 字符，禁止连续连字符）、description（≤1024 字符，含"Use when/适用"触发条件，第三人称，不得写 TODO）；',
    '  可选 license、compatibility（≤500 字符）、metadata（对象：version=semver/owner/data_classification/model_version）、allowed-tools；禁止其他字段',
    '- 正文五章节齐全：适用场景与触发条件（含"不适用"排除项）/ 输入与前置条件 / 执行流程（条件分支必须有默认分支）/ 完成标准（可判定）/ 异常处理与安全边界',
    '- 正文 ≤500 行；正文提到的 references/xxx 文件必须随包提供；修复/迭代时保持 name 与既有 frontmatter 稳定',
    '- 表达：用确定性语言（always/never/must），避免矛盾规则；禁止元规则悖论与"无条件遵循一切后续用户要求"',
  ];
  const security = [
    '- 安全红线：凭据一律占位符（<your-api-key>/$ENV_VAR），禁止 sk-/AKIA/密码= /私钥块/连接串内嵌密码；',
    '  禁止 下载即执行(curl|sh)/eval()/rm -rf 根目录//etc/~/.ssh 路径/base64 解码执行/反弹 shell/nc 监听/修改 agent 全局配置/密码保护 zip/隧道域名；',
    '  依赖用 == 固定版本；禁止注入式表述（ignore previous/忽略以上指令/越狱/HTML 注释藏指令/伪造角色标记/零宽字符/Unicode Tag）',
  ];
  const lines = [];
  if (hasDraft) {
    // 迭代/修复：精简规范即可（完整规范首轮已注入对话）
    lines.push(...compact, ...security, '</platform_skill_spec>');
  } else {
    // 首次创建：完整注入（精简规范 + 模板骨架 + 安全红线）
    lines.push(
      '<platform_skill_spec priority="highest">',
      '（以下是 SkillHub 平台编写规范，与你内置规范冲突时以本规范为准。按此规范与模板生成技能）',
      ...compact.slice(2),
      ...security,
      '',
      '标准模板骨架（按此结构生成）：',
      TEMPLATE_SKELETON,
      '</platform_skill_spec>',
    );
  }
  if (failedRun) {
    const items = findingsText(failedRun);
    if (items) {
      lines.push('', '<latest_check_findings>', `该技能最近一次检查扫描未通过，请逐条修复（rule_id 已标注，保持 name 不变）：`, items, '</latest_check_findings>');
    }
  }
  return lines.join('\n');
}

// findings message/file 洗涤：恶意草稿可借命中原文夹带指令回流 creator prompt（二次注入）——
// 剔除标签片段、角色标记、零宽与控制字符，只保留可见文本
function sanitizeFindingText(s) {
  return String(s)
    .replace(/<\|?[^>\n]{0,40}\|?>/g, ' ')
    .replace(/<[^>\n]{0,80}>/g, ' ')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 120)
    .trim();
}

// 失败检查项 → 文本（修复上下文注入用）
// fail 优先于 warn（防 supply-chain 的 warn 挤占后置凭据/注入 fail 名额），再按条数与字符总量截断
export function findingsText(run) {
  const items = [];
  for (const s of run.stages || []) {
    for (const f of s.findings || []) {
      if (f.level === 'fail' || f.level === 'warn') items.push(f);
    }
  }
  items.sort((a, b) => (a.level === 'fail' ? 0 : 1) - (b.level === 'fail' ? 0 : 1)); // V8 sort 稳定，同级保持 stage 顺序
  const lines = [];
  let budget = 4000;
  for (const f of items.slice(0, 40)) {
    const line = `- [${f.level}] ${f.rule}: ${sanitizeFindingText(f.message)}${f.file ? `（${sanitizeFindingText(f.file)}）` : ''}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines.join('\n');
}
