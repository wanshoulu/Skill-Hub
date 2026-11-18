// orchestrator.js — 统一对话入口（意图路由 + create 转发 build-agent / 流水线编排出 card）
// 以及 gate / eval / evolve 的核心流程（server.js 的 REST 端点也复用）
import { draftDir, saveRun, readRun, listRuns, saveEvidence, readJson, saveJson } from './store.js';
import { createSpecBlock } from './spec.js';
import { runBasic } from './stages/basic.js';
import { runDataset, parseDataset } from './stages/runtime.js';
import { runEvolve } from './evolve.js';
import { llm } from './llm.js';
import { unzip, sha256, packDraftDir, findSkillMd } from './pack.js';
import matter from 'gray-matter';
import fs from 'node:fs';
import { getDraftBoundTools, recommendFromCatalogSemantic } from './mcp.js';
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
    status: run.status === 'degraded' ? 'degraded' : 'passed',
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
    // degraded（judge 不可用、仅规则合取通过）不能吞成 passed：状态原样透传，证据同步真实状态（M6）
    const hasFail = stages.some((s) => s.status === 'fail');
    const hasDegraded = stages.some((s) => s.status === 'degraded');
    run.status = hasFail ? 'failed' : hasDegraded ? 'degraded' : 'passed';
    if (run.status !== 'failed') run.evidence = signEvidence(src.name, src.digest, run);
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
    // degraded 同样透传，不得吞成 passed（M6）
    const hasFail = run.stages.some((s) => s.status === 'fail');
    const hasDegraded = run.stages.some((s) => s.status === 'degraded');
    run.status = hasFail ? 'failed' : hasDegraded ? 'degraded' : 'passed';
    if (run.status !== 'failed') run.evidence = signEvidence(src.name, src.digest, run);
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
// draftId 存在时注入精简规范 + 最近失败检查项（修复闭环）；否则注入完整规范+模板骨架（首次创建）
async function forwardCreate(message, history, emit, mcpBindings = [], draftId = null) {
  emit('phase', { name: '技能创建', status: 'running', detail: '转发 skill-build-agent' });

  // 平台规范注入：企业级编写规范 + 安全基线 + 元模板（生成前约束，事前规避而非仅事后拦截）
  let specContext = '';
  if (draftId) {
    const failedRun = listRuns('gate')
      .filter((r) => r.draft_id === draftId && r.status === 'failed')
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0] || null;
    specContext = createSpecBlock({ hasDraft: true, failedRun });
  } else {
    specContext = createSpecBlock({ hasDraft: false });
  }

  // 构建 MCP 工具上下文（探测失败不阻断创建流程）
  let mcpContext = '';
  if (mcpBindings.length) {
    try {
      // 拆分预置绑定与已注册服务器绑定
      const presetBindings = mcpBindings.filter(b => b._preset);
      const serverBindings = mcpBindings.filter(b => !b._preset);

      const toolSections = [];

      // 已注册服务器：探测真实工具
      if (serverBindings.length) {
        const boundTools = await getDraftBoundTools(serverBindings);
        for (const s of boundTools) {
          toolSections.push(`### ${s.server_name}\n` +
            s.tools.map(t => `- **${t.name}**: ${t.description || '无描述'}\n  参数: ${JSON.stringify(t.inputSchema)}`).join('\n'));
        }
      }

      // 预置目录：直接使用目录描述（无需探测）
      for (const b of presetBindings) {
        const p = b._preset;
        toolSections.push(`### ${p.name}\n${p.description || ''}\n传输: ${p.transport}\n` +
          (p.command ? `命令: ${p.command} ${(p.args || []).join(' ')}\n` : '') +
          (p.url ? `URL: ${p.url}\n` : '') +
          `类别: ${p.category || '通用'}`);
      }

      if (toolSections.length) {
        const toolDescriptions = toolSections.join('\n\n');
        mcpContext = `\n\n<available_mcp_tools>\n${toolDescriptions}\n</available_mcp_tools>\n` +
          `\n创建技能时可引用上述 MCP 工具。在 SKILL.md 中使用如下格式声明工具依赖：\n` +
          '```yaml\nmcp_tools:\n  - server: <server_name>\n    tool: <tool_name>\n```\n';
      }
    } catch (e) {
      emit('phase', { name: 'MCP工具探测', status: 'done', detail: `探测失败：${e.message || e}` });
    }
  }

  const ctrl = new AbortController();
  // 首包超时：agent 初始化 + 建连上限；数据空闲超时：首包后 90s 无任何数据判定卡死
  let abortReason = null;
  let idleTimer = null;
  let firstChunkSeen = false;
  const timeout = setTimeout(() => {
    abortReason = 'skill-build-agent 响应超时（120s）';
    ctrl.abort();
  }, 120_000);
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortReason = 'skill-build-agent 数据流中断（90s 无输出）';
      ctrl.abort();
    }, 90_000);
  };
  const res = await fetch(`${BUILD_AGENT_URL}/api/skill-build-agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message + specContext + mcpContext,
      history,
    }),
    signal: ctrl.signal,
  }).catch((e) => {
    clearTimeout(timeout);
    if (idleTimer) clearTimeout(idleTimer);
    if (e.name === 'AbortError') throw new Error(abortReason || 'skill-build-agent 连接中断');
    throw e;
  });
  if (!res.ok || !res.body) {
    clearTimeout(timeout);
    if (idleTimer) clearTimeout(idleTimer);
    throw new Error(`skill-build-agent HTTP ${res.status}`);
  }

  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  try {
    for await (const chunk of res.body) {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        clearTimeout(timeout); // 首个 chunk 到达后改用 idle 定时器
        armIdle();
      } else {
        armIdle(); // 每个 chunk 到达都喂活 idle 定时器（hb/token 均有效）
      }
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
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(abortReason || 'skill-build-agent 数据流中断');
    throw e;
  } finally {
    clearTimeout(timeout);
    if (idleTimer) clearTimeout(idleTimer);
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
export async function agentChat({ message, history = [], draft_id = null, mode = null, mcp_confirmed = null }, emit) {
  // 1) 意图路由
  let intent = mode && INTENT_LABELS[mode] ? mode : null;
  if (!intent) {
    emit('phase', { name: '意图识别', status: 'running', detail: '' });
    intent = await classifyIntent(message, Boolean(draft_id));
  }
  emit('phase', { name: '意图识别', status: 'done', detail: INTENT_LABELS[intent] });

  // 2) 分发
  if (intent === 'create') {
    // 读取草稿的 MCP 绑定
    let mcpBindings = [];
    if (draft_id) {
      const meta = readJson(`drafts/${draft_id}/meta.json`);
      mcpBindings = meta?.mcp_bindings || [];
    }

    // MCP 市场推荐：用户未携带确认结果时，语义匹配预置目录（LLM 失败回落关键词）
    if (!mcp_confirmed) {
      emit('phase', { name: 'MCP 工具匹配', status: 'running', detail: '语义匹配预置市场' });
      const suggestions = await recommendFromCatalogSemantic(message);
      if (suggestions.length > 0) {
        emit('phase', { name: 'MCP 工具匹配', status: 'done', detail: `匹配 ${suggestions.length} 个工具` });
        emit('card', { type: 'mcp_suggest', payload: { suggestions } });
        // 直接用候选继续创建流程（前端确认后可覆盖）
        const suggestedBindings = suggestions.map(s => ({
          server_id: s.id,
          server_name: s.name,
          tool_names: [],
          _preset: s, // 预置信息（前端用于一键注册）
        }));
        mcpBindings = [...mcpBindings, ...suggestedBindings];
      } else {
        emit('phase', { name: 'MCP 工具匹配', status: 'done', detail: '无需外部工具' });
      }
    } else {
      // 用户已从前端确认选择 → 合并到绑定
      if (Array.isArray(mcp_confirmed) && mcp_confirmed.length > 0) {
        mcpBindings = [...mcpBindings, ...mcp_confirmed];
      }
    }

    const answer = await forwardCreate(message, history, emit, mcpBindings, draft_id);
    // 提取产出（若有）→ card 供前端预览保存；提取失败（如 frontmatter 非法导致 matter 抛错）
    // 回提示 card 而非让整条 SSE 流 error 断掉（M11）
    let art = { markdown: null, files: [], name: null };
    try {
      art = extractArtifacts(answer);
    } catch (e) {
      emit('card', { type: 'hint', payload: { text: `⚠ 产出提取失败（frontmatter 可能不合法）：${e.message || e}，请检查生成内容后重试` } });
    }
    if (art.markdown) {
      if (draft_id) {
        // 草稿已存在（迭代/修复轮）：服务端直接落盘新版 → 立即自动检查 → 结果以 card 回流，
        // 形成「创建 → 检查 → 按检查结果修复」闭环（前端凭 draft_id 跳过重复保存）
        try {
          const baseUpdatedAt = updateDraftArtifacts(draft_id, art);
          emit('card', { type: 'draft_extracted', payload: { draft_id, name: art.name, markdown: art.markdown, files: art.files } });
          emit('phase', { name: '保存后自动检查', status: 'running', detail: '七项静态检查' });
          const run = await runGate({ source: { type: 'draft', id: draft_id }, level: 'check' });
          markDraftCheck(draft_id, run, baseUpdatedAt);
          emit('card', { type: 'gate_stages', payload: runToCard(run) });
          emit('phase', {
            name: '保存后自动检查', status: 'done',
            detail: run.status === 'passed' ? '全部通过' : '存在未通过项，可点击「按检查结果修复」',
          });
        } catch (e) {
          emit('phase', { name: '保存后自动检查', status: 'done', detail: `检查未完成：${e.message || e}` });
        }
      } else {
        // 首次产出：前端保存草稿，保存接口异步触发自动检查（autoCheckDraft）
        emit('card', { type: 'draft_extracted', payload: { name: art.name, markdown: art.markdown, files: art.files } });
      }
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

// 迭代/修复轮：把 agent 产出的新版 SKILL.md 与附件直接写入草稿（路径穿越防护同 server.js writeDraftTo）
// 原子写（tmp+rename，防与用户保存交错出半截文件）；禁改 meta.json；文件数/单文件大小设上限（不完全信任 build-agent 输出）
const MAX_AGENT_FILES = 50;
const MAX_AGENT_FILE_BYTES = 2 * 1024 * 1024;

function atomicWrite(file, content) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

// 返回写入后的 meta.updated_at，供 markDraftCheck 做过期结果防护
function updateDraftArtifacts(id, art) {
  const dir = draftDir(id);
  if (!fs.existsSync(dir)) throw Object.assign(new Error(`草稿不存在：${id}`), { status: 404 });
  atomicWrite(path.join(dir, 'SKILL.md'), art.markdown);
  const files = Array.isArray(art.files) ? art.files.slice(0, MAX_AGENT_FILES) : [];
  for (const f of files) {
    const rel = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel === 'SKILL.md' || rel === 'meta.json') continue;
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) continue;
    const content = String(f.content ?? '');
    if (Buffer.byteLength(content) > MAX_AGENT_FILE_BYTES) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    atomicWrite(abs, content);
  }
  const meta = readJson(`drafts/${id}/meta.json`);
  if (meta) {
    if (art.name) meta.name = art.name;
    meta.updated_at = Date.now();
    saveJson(`drafts/${id}/meta.json`, meta);
    return meta.updated_at;
  }
  return null;
}

// 检查结果回写 meta.last_check（保存即检查；前端草稿列表/看板可直接读取）
// expectedUpdatedAt=检查开始时的草稿 updated_at：期间草稿又被保存过则丢弃本次过期结果，防旧内容的检查覆盖新草稿
function markDraftCheck(id, run, expectedUpdatedAt = null) {
  try {
    const meta = readJson(`drafts/${id}/meta.json`);
    if (meta) {
      if (expectedUpdatedAt && meta.updated_at !== expectedUpdatedAt) return;
      meta.last_check = { run_id: run.id, status: run.status, finished_at: Date.now() };
      saveJson(`drafts/${id}/meta.json`, meta);
    }
  } catch { /* meta 更新失败不影响主流程 */ }
}

// REST 保存草稿后的异步自动检查（fire-and-forget：check 级纯静态秒级完成，失败静默不影响保存）
export function autoCheckDraft(id) {
  (async () => {
    try {
      const startedAt = readJson(`drafts/${id}/meta.json`)?.updated_at ?? null;
      const run = await runGate({ source: { type: 'draft', id }, level: 'check' });
      markDraftCheck(id, run, startedAt);
    } catch { /* 静默 */ }
  })();
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
  const head = run.status === 'passed' ? '通过' : run.status === 'degraded' ? '通过（降级：judge 不可用，仅规则合取）' : '未通过';
  return `${head}｜${parts.join('；')}${run.evidence ? `｜证据已签发 ${run.evidence.digest.slice(0, 12)}…` : ''}`;
}
