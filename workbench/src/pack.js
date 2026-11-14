import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { validateSkill } from './skill.js';

// 打包后 zip 根目录直接是 SKILL.md（注册中心的硬性要求）
const EXCLUDE = new Set(['dist', 'evals', 'node_modules', '.git']);

export function pack(dir) {
  const { errors, skill } = validateSkill(dir);
  if (errors.length) {
    throw new Error(`校验未通过，先修好再打包：\n  - ${errors.join('\n  - ')}`);
  }
  const root = path.resolve(dir);
  const name = skill.data.name;
  const outDir = path.join(root, 'dist');
  fs.mkdirSync(outDir, { recursive: true });

  const zip = new AdmZip();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    // 点文件（.env/.gitignore/.DS_Store…）不进包：防泄密、防污染
    if (entry.name.startsWith('.')) continue;
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) {
      zip.addLocalFolder(p, entry.name);
    } else {
      zip.addLocalFile(p);
    }
  }
  const out = path.join(outDir, `${name}.zip`);
  zip.writeZip(out);
  return out;
}

export function packCmd(dir) {
  const out = pack(dir);
  console.log(`✓ 已打包 ${out}`);
}
