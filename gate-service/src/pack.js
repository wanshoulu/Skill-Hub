// pack.js — zip 解包/打包 + sha256 digest（全内存，无 tmp 残留）
import crypto from 'node:crypto';
import fs from 'node:fs';
import AdmZip from 'adm-zip';

// 归档安全限制（参考 Cisco Skill Scanner 阈值）
const MAX_FILES = 500;
const MAX_UNCOMPRESSED_SIZE = 50 * 1024 * 1024; // 50 MB
const ZIP_BOMB_RATIO = 100; // 压缩比超过 100:1 判定为 zip-bomb

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function isTextFile(name) {
  return /\.(md|markdown|txt|yaml|yml|json|py|js|ts|jsx|tsx|sh|bash|html|css|xml|csv|toml|ini|cfg)$/i.test(name)
    || !name.includes('.'); // 无扩展名按文本处理
}

// 解包 zip → { files: [{path, text}], digest, warnings }
// 兼容两种布局：根目录直接 SKILL.md（CLI pack 的产物）/ 包一层 <name>/ 目录
export function unzip(buf) {
  const zip = new AdmZip(buf);
  const warnings = [];
  const raw = [];

  // 归档安全检查
  const entries = zip.getEntries();
  if (entries.length > MAX_FILES) {
    throw new Error(`zip 内文件数 ${entries.length} 超过上限 ${MAX_FILES}（可能为 zip-bomb 或恶意技能包）`);
  }

  let totalUncompressed = 0;
  let totalCompressed = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    totalUncompressed += entry.header.size;
    totalCompressed += entry.header.compressedSize;
    // 符号链接检测（Unix symlink 位）
    if (entry.header.attr & 0xA000 && (entry.header.attr & 0xF000) === 0xA000) {
      warnings.push(`已跳过符号链接：${entry.entryName}`);
      continue;
    }
    let name = entry.entryName.replace(/\\/g, '/');
    // zip-slip 防护：拒绝路径穿越与绝对路径
    if (name.startsWith('/') || name.split('/').some((seg) => seg === '..')) {
      warnings.push(`已跳过可疑路径：${name}`);
      continue;
    }
    name = name.replace(/^\.\//, '');
    raw.push({ name, content: entry.getData() });
  }

  // 总大小限制
  if (totalUncompressed > MAX_UNCOMPRESSED_SIZE) {
    throw new Error(`zip 解压后总大小 ${Math.round(totalUncompressed / 1024 / 1024)}MB 超过上限 ${MAX_UNCOMPRESSED_SIZE / 1024 / 1024}MB`);
  }

  // zip-bomb 检测：压缩比超过阈值
  if (totalCompressed > 0 && totalUncompressed / totalCompressed > ZIP_BOMB_RATIO) {
    throw new Error(`zip 压缩比 ${Math.round(totalUncompressed / totalCompressed)}:1 超过阈值 ${ZIP_BOMB_RATIO}:1（疑似 zip-bomb 攻击）`);
  }

  if (!raw.length) throw new Error('zip 内没有文件');

  // 嵌套一层目录的兼容：唯一顶层目录且其下有 SKILL.md → 剥前缀
  const tops = new Set(raw.map((f) => f.name.split('/')[0]));
  const nestedAll = tops.size === 1 && raw.every((f) => f.name.includes('/'));
  const hasNestedSkill = raw.some((f) => f.name.split('/').slice(1).join('/') === 'SKILL.md');
  const prefix = nestedAll && hasNestedSkill ? `${[...tops][0]}/` : '';

  const files = raw.map((f) => {
    const p = prefix && f.name.startsWith(prefix) ? f.name.slice(prefix.length) : f.name;
    return { path: p, content: f.content, text: isTextFile(p) ? f.content.toString('utf8') : null };
  });
  return { files, digest: sha256(buf), warnings, zipName: prefix ? prefix.slice(0, -1) : null };
}

// 从 files map 里找 SKILL.md 并解析 frontmatter（basic 检查也用它，导出复用）
export function findSkillMd(files) {
  return files.find((f) => f.path === 'SKILL.md') || null;
}

// 草稿目录 → zip buffer（drafts/:id/zip 与 evidence 打包用）
export function packDraftDir(dir) {
  const zip = new AdmZip();
  const addDir = (d, base) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (!base && (entry.name === 'meta.json' || entry.name === 'evals' || entry.name === 'history')) continue;
      const p = `${d}/${entry.name}`;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        addDir(p, rel);
      } else {
        zip.addFile(rel, fs.readFileSync(p));
      }
    }
  };
  addDir(dir, '');
  return zip.toBuffer();
}

export function packDraftFiles(markdown, files = []) {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(markdown, 'utf8'));
  for (const f of files) {
    const p = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!p || p.includes('..') || p === 'SKILL.md') continue;
    zip.addFile(p, Buffer.from(String(f.content ?? ''), 'utf8'));
  }
  return zip.toBuffer();
}
