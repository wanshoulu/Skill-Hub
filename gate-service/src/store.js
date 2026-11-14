// store.js — /data 下的 JSON 落盘（原子写）+ 目录布局 + 技能 seed
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');

const DIRS = {
  runsGate: 'runs/gate',
  runsEval: 'runs/eval',
  runsEvolve: 'runs/evolve',
  evidence: 'evidence',
  drafts: 'drafts',
  tmp: 'tmp',
  skillsCustom: 'skills/custom',
  skillsOfficial: 'skills/official',
};

export function dirOf(key) {
  return path.join(DATA_DIR, DIRS[key]);
}

export async function ensureDirs() {
  for (const d of Object.values(DIRS)) {
    await fsp.mkdir(path.join(DATA_DIR, d), { recursive: true });
  }
}

// JSON 原子写：先写 .tmp 再 rename，进程崩溃不留半个文件
export function saveJson(relPath, obj) {
  const abs = path.join(DATA_DIR, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, abs);
  return abs;
}

export function readJson(relPath) {
  const abs = path.join(DATA_DIR, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

// ── runs / evidence ──────────────────────────────────────────────

export function saveRun(kind, run) {
  return saveJson(`runs/${kind}/${run.id}.json`, run);
}

export function readRun(kind, id) {
  // id 防路径穿越
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return readJson(`runs/${kind}/${id}.json`);
}

export function listRuns(kind) {
  const dir = path.join(DATA_DIR, 'runs', kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(`runs/${kind}/${f}`))
    .filter(Boolean)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

export function saveEvidence(name, digest, ev) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`非法技能名 ${name}`);
  return saveJson(`evidence/${name}/${digest}.json`, ev);
}

export function readEvidence(name, digest) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) return null;
  return readJson(`evidence/${name}/${digest}.json`);
}

// ── drafts ───────────────────────────────────────────────────────

export function draftDir(id) {
  if (!/^d[A-Za-z0-9_-]+$/.test(id)) throw new Error(`非法 draft_id ${id}`);
  return path.join(DATA_DIR, 'drafts', id);
}

// ── seed：首次启动把 deploy/seed/skills-custom 拷进 /data/skills/custom ──

export async function seedSkills() {
  const seedDir = process.env.SEED_DIR || '/seed/skills-custom';
  const target = dirOf('skillsCustom');
  if (!fs.existsSync(seedDir)) return { seeded: false, reason: 'no seed dir' };
  await fsp.mkdir(target, { recursive: true });
  const existing = new Set(fs.readdirSync(target));
  let seeded = [];
  for (const name of fs.readdirSync(seedDir)) {
    if (existing.has(name)) continue; // 已存在不覆盖
    await fsp.cp(path.join(seedDir, name), path.join(target, name), { recursive: true });
    seeded.push(name);
  }
  return { seeded, target };
}
