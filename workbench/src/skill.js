import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

// agentskills 规范：name 只允许小写字母/数字/连字符
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const NAME_MAX = 64;
const DESC_MAX = 1024;

export function loadSkill(dir) {
  const skillPath = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    throw new Error(`未找到 ${path.resolve(skillPath)}`);
  }
  const raw = fs.readFileSync(skillPath, 'utf8');
  const { data, content } = matter(raw);
  return { dir: path.resolve(dir), data, content, skillPath };
}

export function validateSkill(dir) {
  const errors = [];
  const warnings = [];
  let skill = null;
  try {
    skill = loadSkill(dir);
  } catch (e) {
    return { errors: [e.message], warnings, skill: null };
  }
  const { data, content } = skill;

  // name
  const name = data.name;
  if (name == null || name === '') {
    errors.push('frontmatter 缺少 name');
  } else if (typeof name !== 'string' || !NAME_RE.test(name)) {
    errors.push(
      `name 非法："${name}"（只允许小写字母、数字、连字符，且以字母数字开头）`
    );
  } else if (name.length > NAME_MAX) {
    errors.push(`name 超过 ${NAME_MAX} 字符（当前 ${name.length}）`);
  }

  // description：agent 靠它决定是否加载，必填且有长度上限
  const desc = data.description;
  if (desc == null || desc === '') {
    errors.push('frontmatter 缺少 description');
  } else if (typeof desc !== 'string') {
    errors.push('description 必须是字符串');
  } else if (desc.length > DESC_MAX) {
    errors.push(`description 超过 ${DESC_MAX} 字符（当前 ${desc.length}）`);
  } else if (/TODO/i.test(desc)) {
    warnings.push('description 还是模板占位文案（含 TODO），发布前记得改成真实描述');
  }

  // 正文：指令内容必须写在正文里
  if (!content || !content.trim()) {
    errors.push('SKILL.md 正文为空');
  }

  // 目录名与 name 不一致只警告，不拦截
  const dirName = path.basename(path.resolve(dir));
  if (typeof name === 'string' && dirName && dirName !== name) {
    warnings.push(`目录名 "${dirName}" 与 name "${name}" 不一致`);
  }

  return { errors, warnings, skill };
}

export function validateCmd(dir) {
  const { errors, warnings } = validateSkill(dir);
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const e of errors) console.error(`✗ ${e}`);
  if (errors.length === 0) {
    console.log(`✓ ${path.resolve(dir)} 校验通过${warnings.length ? `（${warnings.length} 个警告）` : ''}`);
    return;
  }
  process.exitCode = 1;
}
