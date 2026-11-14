// orchestrator.js — 统一对话入口（意图路由 + create 转发 build-agent / 流水线编排出 card）
// 以及 gate / eval / evolve 的核心流程（server.js 的 REST 端点也复用）
import { draftDir, saveRun, readRun, listRuns, saveEvidence, readJson } from './store.js';
import { runBasic } from './stages/basic.js';
import { runDataset, parseDataset } from './stages/runtime.js';
import { runEvolve } from './evolve.js';
import { llm } from './llm.js';
import { unzip, sha256, packDraftDir, findSkillMd } from './pack.js';
import matter from 'gray-matter';
import fs from 'node:fs';
import path from 'node:path';

const BUILD_AGENT_URL = (process.env.BUILD_AGENT_URL || 'http://skill-build-agent:8300').replace(/\/+$/, '');

const INTENT_LABELS = { create: '技能创建', validate: '技能检查扫描', eval: '技能测评', evolve: '技能进化', adopt: '采纳进化候选' };

// ── 资源装载 ─────────────────────────────────────────────────────

// 草稿 → files（含 SKILL.md）
export function readDraftFiles(id) {
  const dir = draftDir(id);
  if (!fs.existsSync(dir)) throw Object.assign(new Error(`草稿不存在：${id}`), { status: 404 });
  const out = [];
  const walk = (d, base) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
      else if (entry.name !== 'meta.json') {
        const buf = fs.readFileSync(path.join(d, entry.name));
        out.push({ path: rel, text: buf.toString('utf8') });
      }
    }
  };
  walk(dir, '');
  return out;
}

function readDraftDataset(id) {
  const p = path.join(draftDir(id), 'evals', 'dataset.yaml');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

async function loadSource(source) {
  if (source.type === 'draft') {
    const meta = readJson(`drafts/${source.id}/meta.json`);
    if (!meta) throw Object.assign(new Error(`草稿不存在：${source.id}`), { status: 404 });
    const files = readDraftFiles(source.id);
    const zip = packDraftDir(draftDir(source.id));
    return { files, name: meta.name, digest: sha256(zip), datasetYaml: readDraftDataset(source.id), draft_id: source.id };
  }
  // zip 上传
  const { files, digest, zipName } = unzip(source.buf);
  const skillMd = findSkillMd(files);
  if (!skillMd) throw new Error('zip 内缺少 SKILL.md（根目录必须直接是 SKILL.md）');
  const name = matter(skillMd.text).data?.name || zipName || 'unknown';
  return { files, name, digest, datasetYaml: source.datasetYaml ?? null, draft_id: null };
}

function summaryOf(stages) {
  return stages.map((s) => ({ stage_id: s.stage_id, title: s.title, status: s.status, threshold: s.threshold, metrics: s.metrics, findings: s.findings }));
}

function signEvidence(name, digest, run) {
  const ev = {
    name,
    ns: run.ns || null,
    digest,
    gate_run_id: run.id,
    eval_run_id: run.kind === 'eval' ? run.id : undefined,
    level: run.level,
    status: 'passed',
    released: true,
    signed_at: new Date().toISOString(),
    stages: summaryOf(run.stages),
  };
  saveEvidence(name, digest, ev);
  return ev;
}

// ── 核心流程（REST 与对话共用）───────────────────────────────────

function genRunId(kind) {
  return `${kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// level: check（仅 basic）/ release（默认；无 dataset 直接 fail）
// begin 同步创建 run 落盘并返回（REST 层立即拿到 run_id）；execute 异步执行
export function beginGate({ level = 'release', ns = null } = {}) {
  const run = { id: genRunId('gate'), kind: 'gate', status: 'running', level, ns, created_at: Date.now() };
  saveRun('gate', run);
  return run;
}

export async function executeGate(run, { source }, onProgress = () => {}) {
  try {
    const src = await loadSource(source);
    run.name = src.name;
    run.content_digest = src.digest;
    run.draft_id = src.draft_id;
    onProgress({ phase: 'basic-check', detail: '五项静态检查' });
    let stages = runBasic({ name: src.name, files: src.files });

    const datasetYaml = src.datasetYaml;
    if (run.level === 'release' && !datasetYaml) {
      stages.push({
        stage_id: 'dataset-required', title: '测评用例集', kind: 'runtime', status: 'fail', threshold: null, metrics: {},
        cases: [], findings: [{ level: 'fail', rule: 'dataset-missing', message: 'release 级门禁必须提供 evals/dataset.yaml（skw dataset init 生成）', file: '' }],
      });
    } else if (datasetYaml) {
      const dataset = parseDataset(datasetYaml); // 解析失败 → throw → run failed
      run.dataset_digest = sha256(Buffer.from(datasetYaml, 'utf8'));
      run.dataset_scope = dataset.scope;
      onProgress({ phase: 'runtime-eval', detail: `技能测评（${dataset.scope}，${dataset.cases.length} 用例）` });
      const skillMd = findSkillMd(src.files);
      stages.push(...(await runDataset(
        { skillBody: skillMd?.text || '', skillDesc: matter(skillMd?.text || '').data?.description || '', dataset },
        onProgress,
      )));
    }

    run.stages = stages;
    run.status = stages.every((s) => s.status !== 'fail') ? 'passed' : 'failed';
    if (run.status === 'passed') run.evidence = signEvidence(src.name, src.digest, run);
    run.finished_at = Date.now();
    saveRun('gate', run);
    return run;
  } catch (e) {
    run.status = 'failed';
    run.error = String(e.message || e);
    run.finished_at = Date.now();
    saveRun('gate', run);
    return run;
  }
}

export async function runGate({ source, level = 'release', ns = null }, onProgress = () => {}) {
  const run = beginGate({ level, ns });
  return executeGate(run, { source }, onProgress);
}

// 单独重跑测评（不跑 basic）
export function beginEval({ ns = null } = {}) {
  const run = { id: genRunId('eval'), kind: 'eval', status: 'running', level: 'eval', ns, created_at: Date.now() };
  saveRun('eval', run);
  return run;
}

export async function executeEval(run, { source }, onProgress = () => {}) {
  try {
    const src = await loadSource(source);
    if (!src.datasetYaml) throw new Error('缺少 evals/dataset.yaml（草稿未上传或 zip 未带 dataset 参数）');
    const dataset = parseDataset(src.datasetYaml);
    run.name = src.name;
    run.content_digest = src.digest;
    run.dataset_digest = sha256(Buffer.from(src.datasetYaml, 'utf8'));
    run.dataset_scope = dataset.scope;
    run.draft_id = src.draft_id;
    onProgress({ phase: 'runtime-eval', detail: `技能测评（${dataset.scope}，${dataset.cases.length} 用例）` });
    const skillMd = findSkillMd(src.files);
    run.stages = await runDataset(
      { skillBody: skillMd?.text || '', skillDesc: matter(skillMd?.text || '').data?.description || '', dataset },
      onProgress,
    );
    run.status = run.stages.every((s) => s.status !== 'fail') ? 'passed' : 'failed';
    if (run.status === 'passed') run.evidence = signEvidence(src.name, src.digest, run);
    run.finished_at = Date.now();
    saveRun('eval', run);
    return run;
  } catch (e) {
    run.status = 'failed';
    run.error = String(e.message || e);
    run.finished_at = Date.now();
    saveRun('eval', run);
    return run;
  }
}

export async function runEval({ source, ns = null }, onProgress = () => {}) {
  const run = beginEval({ ns });
  return executeEval(run, { source }, onProgress);
}

// 进化（异步 job）
export async function startEvolve({ source, maxRounds = 3, ns = null }) {
  const job = {
    id: `evolve_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: 'evolve', status: 'running', max_rounds: maxRounds, ns, created_at: Date.now(),
  };
  saveRun('evolve', job);
  const onProgress = (p) => { job.progress = { ...p, at: Date.now() }; saveRun('evolve', job); };
  (async () => {
    try {
      const src = await loadSource(source);
      if (!src.datasetYaml) throw new Error('缺少 evals/dataset.yaml：进化以失败用例为驱动，必须提供测评用例集');
      job.name = src.name;
      job.draft_id = src.draft_id;
      job.content_digest = src.digest;
      const result = await runEvolve({ files: src.files, dataset: parseDataset(src.datasetYaml), maxRounds }, onProgress);
      Object.assign(job, result, { progress: null, finished_at: Date.now() });
      saveRun('evolve', job);
    } catch (e) {
      Object.assign(job, { status: 'failed', error: String(e.message || e), progress: null, finished_at: Date.now() });
      saveRun('evolve', job);
    }
  })();
  return job;
}

// 采纳：备份草稿 SKILL.md → 覆盖为候选 → 自动重走 gate（release）
export async function adoptJob(jobId) {
  const job = readRun('evolve', jobId);
  if (!job) throw Object.assign(new Error(`进化任务不存在：${jobId}`), { status: 404 });
  if (job.status !== 'done') throw new Error(`进化任务尚未完成（${job.status}）`);
  if (job.conclusion !== 'adoptable') throw new Error('该候选未通过采纳标准（有未修复失败或存在回归），不可采纳');
  if (job.adopted_at) throw new Error('该候选已被采纳过');
  if (!job.draft_id) throw new Error('该任务不是基于草稿发起的（CLI 流请用 skw evolve adopt 本地覆盖）');

  const dir = draftDir(job.draft_id);
  const skillPath = path.join(dir, 'SKILL.md');
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  const backup = `history/${Date.now()}-SKILL.md`;
  fs.copyFileSync(skillPath, path.join(dir, backup));
  const lastRound = job.rounds?.[job.rounds.length - 1];
  fs.writeFileSync(skillPath, lastRound?.candidate_md || '', 'utf8');
  job.adopted_at = Date.now();
  job.backup_path = backup;
  saveRun('evolve', job);

  // 自动重走检查扫描+测评（release 级）
  const gateRun = await runGate({ source: { type: 'draft', id: job.draft_id }, level: 'release', ns: job.ns });
  return { job, backup, gate_run_id: gateRun.id, gate_status: gateRun.status };
}

// ── 对话入口 ─────────────────────────────────────────────────────

// 意图路由：qwen 单次分类，失败兜底 create（对话永不卡死）
async function classifyIntent(message, hasDraft) {
  try {
    const data = await llm.chatJson([
      {
        role: 'system',
        content:
          '你是「技能构建」平台的意图分类器。五类任务：\n' +
          '- create：创建新技能、修改技能内容、对话式生成 SKILL.md\n' +
          '- validate：对当前草稿做检查扫描（五项静态检查）\n' +
          '- eval：对当前草稿跑技能测评（真实用例打分）\n' +
          '- evolve：基于失败用例反思重写、进化当前草稿\n' +
          '- adopt：采纳最近的进化候选（确认采用重写版）\n' +
          '只输出 JSON：{"intent": "create|validate|eval|evolve|adopt"}',
      },
      {
        role: 'user',
        content: `当前上下文：${hasDraft ? '已有一个技能草稿' : '尚无草稿'}\n用户消息：${message.slice(0, 500)}`,
      },
    ], { temperature: 0, maxTokens: 60, timeoutMs: 12_000 });
    const intent = String(data.intent || '').toLowerCase();
    return INTENT_LABELS[intent] ? intent : 'create';
  } catch {
    return 'create'; // 分类失败兜底
  }
}

// 从 build-agent 回答里提取 ```skill-md / ```skill-file 产出
export function extractArtifacts(answer) {
  const files = [];
  let markdown = null;
  let name = null;
  const re = /```(skill-md|skill-file)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(answer))) {
    if (m[1] === 'skill-md') markdown = m[2].replace(/\s+$/, '');
    else {
      const body = m[2].replace(/^\r?\n/, '');
      const first = body.split('\n', 1)[0] || '';
      const pm = first.match(/^path:\s*(.+)$/);
      if (pm) files.push({ path: pm[1].trim(), content: body.slice(first.length + 1) });
    }
  }
  if (markdown) {
    name = matter(markdown).data?.name || null;
  }
  return { markdown, files, name };
}

// create：转发 skill-build-agent（事件原样透传），done 后提取产出 card
async function forwardCreate(message, history, emit) {
  emit('phase', { name: '技能创建', status: 'running', detail: '转发 skill-build-agent' });
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 120_000);
  const res = await fetch(`${BUILD_AGENT_URL}/api/skill-build-agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history }),
    signal: ctrl.signal,
  }).catch((e) => {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('skill-build-agent 响应超时（120s）');
    throw e;
  });
  if (!res.ok || !res.body) { clearTimeout(timeout); throw new Error(`skill-build-agent HTTP ${res.status}`); }

  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  for await (const chunk of res.body) {
    clearTimeout(timeout); // 首个 chunk 到达后改用 idle 定时器
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = parseSseBlock(block);
      if (!ev) continue;
      if (ev.event === 'result') answer = ev.data?.answer || answer;
      if (ev.event === 'done') continue; // done 由 server.js 统一发，避免双 done
      emit(ev.event, ev.data); // phase/token/result/done/error/hb 原样透传
    }
  }
  return answer;
}

function parseSseBlock(block) {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

// 统一对话入口。emit(event, data) 由 server.js 的 SSE writer 提供
export async function agentChat({ message, history = [], draft_id = null, mode = null }, emit) {
  // 1) 意图路由
  let intent = mode && INTENT_LABELS[mode] ? mode : null;
  if (!intent) {
    emit('phase', { name: '意图识别', status: 'running', detail: '' });
    intent = await classifyIntent(message, Boolean(draft_id));
  }
  emit('phase', { name: '意图识别', status: 'done', detail: INTENT_LABELS[intent] });

  // 2) 分发
  if (intent === 'create') {
    const answer = await forwardCreate(message, history, emit);
    // 提取产出（若有）→ card 供前端预览保存
    const art = extractArtifacts(answer);
    if (art.markdown) {
      emit('card', { type: 'draft_extracted', payload: { name: art.name, markdown: art.markdown, files: art.files } });
    }
    return;
  }

  // 流水线意图：都需要草稿
  if (!draft_id) {
    const tip = '当前没有草稿。请先用「技能创建」对话生成技能并保存，或指定 draft_id 后重试。';
    emit('card', { type: 'hint', payload: { text: tip } });
    emit('result', { answer: tip });
    return;
  }

  try {
    if (intent === 'validate') {
      const run = await runGate({ source: { type: 'draft', id: draft_id }, level: 'check' }, (p) => emit('phase', { name: p.phase, status: 'running', detail: p.detail }));
      emit('card', { type: 'gate_stages', payload: runToCard(run) });
      emit('result', { answer: resultText(run) });
    } else if (intent === 'eval') {
      const run = await runEval({ source: { type: 'draft', id: draft_id } }, (p) => emit('phase', { name: p.phase, status: 'running', detail: p.detail }));
      emit('card', { type: 'eval_report', payload: runToCard(run) });
      emit('result', { answer: resultText(run) });
    } else if (intent === 'evolve') {
      const job = await startEvolve({ source: { type: 'draft', id: draft_id } });
      // 轮询 job 进度（内部已异步），推 phase；完成出 card
      let lastPhase = '';
      while (job.status === 'running') {
        const cur = readRun('evolve', job.id);
        if (!cur) { await new Promise((r) => setTimeout(r, 800)); continue; }
        Object.assign(job, cur);
        if (cur?.progress?.phase && cur.progress.phase !== lastPhase) {
          lastPhase = cur.progress.phase;
          emit('phase', { name: lastPhase, status: 'running', detail: cur.progress.detail || '' });
        }
        await new Promise((r) => setTimeout(r, 800));
        if (Date.now() - job.created_at > 15 * 60_000) throw new Error('进化任务超时（15 分钟）');
      }
      if (job.status === 'failed') throw new Error(job.error || '进化失败');
      const lastRound = job.rounds?.[job.rounds.length - 1] || {};
      emit('card', {
        type: 'evolve_report',
        payload: {
          job_id: job.id, conclusion: job.conclusion, message: job.message,
          diagnosis: lastRound.diagnosis || [], summary: lastRound.summary || '',
          compare: lastRound.compare || null,
          candidate_md: lastRound.candidate_md || null,
          base_md: readDraftSkillMd(draft_id),
        },
      });
      emit('result', { answer: job.message });
    } else if (intent === 'adopt') {
      // 找该草稿最新的可采纳 job
      const jobs = listRuns('evolve').filter((j) => j.draft_id === draft_id && j.conclusion === 'adoptable' && !j.adopted_at);
      if (!jobs.length) {
        const tip = '没有可采纳的进化候选。请先发起「技能进化」。';
        emit('card', { type: 'hint', payload: { text: tip } });
        emit('result', { answer: tip });
        return;
      }
      emit('phase', { name: '采纳候选', status: 'running', detail: jobs[0].id });
      const { job, backup, gate_run_id, gate_status } = await adoptJob(jobs[0].id);
      emit('card', { type: 'adopt_done', payload: { job_id: job.id, backup, gate_run_id, gate_status } });
      emit('result', { answer: `已采纳候选 ${job.id}（原 SKILL.md 备份到 ${backup}），已自动重走检查扫描+测评：${gate_status}` });
    }
  } catch (e) {
    emit('error', { error: String(e.message || e) });
  }
}

function readDraftSkillMd(draftId) {
  try {
    return fs.readFileSync(path.join(draftDir(draftId), 'SKILL.md'), 'utf8');
  } catch {
    return null;
  }
}

// run → card payload（精简：stage 摘要 + runtime 带 cases）
export function runToCard(run) {
  return {
    run_id: run.id, kind: run.kind, status: run.status, level: run.level,
    name: run.name, content_digest: run.content_digest, dataset_scope: run.dataset_scope,
    error: run.error,
    evidence: run.evidence ? { digest: run.evidence.digest, signed_at: run.evidence.signed_at } : null,
    stages: run.stages,
  };
}

function resultText(run) {
  const parts = (run.stages || []).map((s) => {
    const m = s.metrics || {};
    const metric = m.accuracy !== undefined ? `通过率 ${Math.round(m.accuracy * 100)}%（${m.passed}/${m.total}，阈值 ${s.threshold}）` : '';
    return `${s.title}：${s.status}${metric ? '，' + metric : ''}`;
  });
  const head = run.status === 'passed' ? '通过' : '未通过';
  return `${head}｜${parts.join('；')}${run.evidence ? `｜证据已签发 ${run.evidence.digest.slice(0, 12)}…` : ''}`;
}
