import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getConfig } from './config.js';

const HTTP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_MS = 120_000;

function truncate(text, max = 300) {
  const s = String(text ?? '').trim();
  return s.length <= max ? s : `${s.slice(0, max)}…（共 ${s.length} 字符）`;
}

function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'code' in payload && 'data' in payload) {
    if (payload.code !== 0 && payload.code !== null) {
      throw new Error(`Gate API 错误 ${payload.code}: ${payload.msg ?? ''}`);
    }
    return payload.data;
  }
  return payload;
}

async function gateApi(cfg, pathname, init = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const res = await fetch(`${cfg.gateUrl}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${cfg.gateToken}`, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${pathname}: ${truncate(await res.text())}`);
  }
  return unwrap(await res.json());
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// release 级门禁：zip 上传 + dataset 走独立字段（pack 不把 evals 打进 zip，保持包体干净）
async function startRun(cfg, zipPath, skillDir) {
  const buf = fs.readFileSync(zipPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/zip' }), path.basename(zipPath));
  form.append('level', 'release');
  const dsPath = path.join(skillDir, 'evals', 'dataset.yaml');
  if (fs.existsSync(dsPath)) {
    form.append('dataset', new Blob([fs.readFileSync(dsPath)], { type: 'text/yaml' }), 'dataset.yaml');
    console.log('  携带测评集 evals/dataset.yaml');
  } else {
    console.log('  ⚠ 无 evals/dataset.yaml：release 级测评项会被 dataset-required 拦截');
  }
  return gateApi(cfg, '/v1/gate/run', { method: 'POST', body: form });
}

async function pollRun(cfg, runId) {
  const deadline = Date.now() + POLL_MAX_MS;
  for (;;) {
    const run = await gateApi(cfg, `/v1/gate/runs/${runId}`);
    if (run && run.status !== 'running') return run;
    if (Date.now() > deadline) {
      throw new Error(`门禁超时（${Math.round(POLL_MAX_MS / 1000)}s）：run ${runId} 仍在执行`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function printFindings(run) {
  for (const stage of run.stages ?? []) {
    const mark =
      stage.status === 'pass' ? '✓' : stage.status === 'warn' ? '⚠' : '✗';
    console.log(`  ${mark} ${stage.title ?? stage.stage_id}（${stage.status}）`);
    for (const f of stage.findings ?? []) {
      console.log(`    [${f.level}] ${f.rule}: ${truncate(f.message, 160)}${f.file ? `（${f.file}）` : ''}`);
    }
  }
}

export function printGateReport(run) {
  console.log(`  门禁结果：${run.status === 'passed' ? '✓ 通过' : '✗ 未通过'}`);
  printFindings(run);
}

// publish 强制门禁入口：返回 { run, digest }，digest 与 evidence 绑定
export async function gateRunRelease({ zipPath, skillDir }) {
  const cfg = getConfig();
  if (!cfg.gateUrl) {
    throw new Error('缺少 gateUrl：环境变量 SKW_GATE_URL 或写进 ~/.skw/config.json');
  }
  if (!cfg.gateToken) {
    throw new Error('缺少 gateToken：环境变量 SKW_GATE_TOKEN 或写进 ~/.skw/config.json');
  }
  cfg.gateUrl = cfg.gateUrl.replace(/\/+$/, '');

  const digest = sha256File(zipPath);
  const started = await startRun(cfg, zipPath, skillDir);
  const runId = started?.run_id ?? started?.id;
  if (!runId) {
    throw new Error(`门禁响应异常：未返回 run_id（${JSON.stringify(started).slice(0, 200)}）`);
  }
  const run = await pollRun(cfg, runId);

  if (run.status === 'passed') {
    // 双重校验：证据必须已签发且 content_digest 与本次 zip 绑定
    const ev = await gateApi(cfg, `/v1/evidence/gate/${run.name}/${digest}`);
    if (!ev?.released) {
      throw new Error(`门禁证据缺失或 digest 不匹配（${run.name}@${digest.slice(0, 8)}…）`);
    }
    console.log(`  ✓ 证据已签发 content_digest=${digest.slice(0, 12)}…`);
  }
  return { run, digest };
}
