import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function init(name, opts = {}) {
  if (!NAME_RE.test(name)) {
    throw new Error(`skill 名非法："${name}"（只允许小写字母、数字、连字符）`);
  }
  const target = path.resolve(opts.dir || '.', name);
  if (fs.existsSync(target)) {
    throw new Error(`目录已存在：${target}`);
  }
  const templateDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'templates',
    'default'
  );
  fs.cpSync(templateDir, target, { recursive: true });

  // 替换模板占位符
  const skillPath = path.join(target, 'SKILL.md');
  let skillMd = fs.readFileSync(skillPath, 'utf8').replaceAll('{{name}}', name);
  if (opts.desc) {
    // 不给 --desc 时保留模板里的 TODO 提示，让 validate 通过但提醒用户去填
    skillMd = skillMd.replace(/^description: .*$/m, `description: ${opts.desc}`);
  }
  fs.writeFileSync(skillPath, skillMd);

  // 生成评测用例模板（mock provider 离线即可跑通）
  const evalsDir = path.join(target, 'evals');
  fs.mkdirSync(evalsDir, { recursive: true });
  fs.writeFileSync(
    path.join(evalsDir, 'cases.yaml'),
    [
      'cases:',
      `  - id: demo-1`,
      `    input: ${name} 怎么用？`,
      '    expect_contains:',
      `      - ${name}`,
      '',
    ].join('\n')
  );

  return target;
}
