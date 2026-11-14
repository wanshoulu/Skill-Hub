// stages/runtime.js — 技能测评：trigger-evaluation + task-evaluation（真实 LLM 用例驱动）
import YAML from 'yaml';
import { llm } from '../llm.js';
import { judgeTrigger, judgeTask } from '../judge.js';

export const THRESHOLDS_BY_SCOPE = {
  SMOKE: { trigger_accuracy: 0.6, pass_rate: 0.6 },
  REGRESSION: { trigger_accuracy: 0.8, pass_rate: 0.8 },
  RELEASE: { trigger_accuracy: 0.9, pass_rate: 0.9 },
};

// 解析 dataset.yaml → {scope, thresholds, cases}；抛错给用户可读信息
export function parseDataset(yamlText) {
  let ds;
  try {
    ds = YAML.parse(yamlText);
  } catch (e) {
    throw new Error(`dataset.yaml 解析失败：${e.message}`);
  }
  if (!ds || typeof ds !== 'object') throw new Error('dataset.yaml 内容为空');
  const scope = String(ds.scope || 'SMOKE').toUpperCase();
  if (!THRESHOLDS_BY_SCOPE[scope]) throw new Error(`非法 scope：${ds.scope}（可选 SMOKE/REGRESSION/RELEASE）`);
  const cases = Array.isArray(ds.cases) ? ds.cases : [];
  if (!cases.length) throw new Error('dataset.yaml 缺少 cases 或 cases 为空');
  const normalized = cases.map((c, i) => {
    const kind = String(c.kind || '').toUpperCase();
    if (!['TRIGGER_POSITIVE', 'TRIGGER_NEGATIVE', 'BOUNDARY', 'TASK'].includes(kind)) {
      throw new Error(`cases[${i}].kind 非法："${c.kind}"（可选 TRIGGER_POSITIVE/TRIGGER_NEGATIVE/BOUNDARY/TASK）`);
    }
    if (!c.input || !String(c.input).trim()) throw new Error(`cases[${i}].input 不能为空`);
    if (kind === 'BOUNDARY' && c.expect === undefined) {
      throw new Error(`cases[${i}]（BOUNDARY）必须显式给 expect: true|false`);
    }
    return {
      id: String(c.id || `case-${i + 1}`),
      kind,
      input: String(c.input),
      expect: c.expect === undefined ? undefined : Boolean(c.expect),
      expected_keywords: toStrArray(c.expected_keywords),
      expected_regex: toStrArray(c.expected_regex),
      required_tools: toStrArray(c.required_tools),
      forbidden_tools: toStrArray(c.forbidden_tools),
      llm_judge_rubric: c.llm_judge_rubric ? String(c.llm_judge_rubric) : null,
      holdout: Boolean(c.holdout),
    };
  });
  return { scope, thresholds: { ...THRESHOLDS_BY_SCOPE[scope], ...(ds.thresholds || {}) }, cases: normalized };
}

function toStrArray(v) {
  return Array.isArray(v) ? v.map(String) : [];
}

const clip = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

// 跑 dataset → stage 结果列表。onProgress({phase, detail}) 供对话流推进度
export async function runDataset({ skillBody, skillDesc, dataset }, onProgress) {
  const { scope, thresholds, cases } = dataset;
  const triggerCases = cases.filter((c) => c.kind !== 'TASK');
  const taskCases = cases.filter((c) => c.kind === 'TASK');
  const stages = [];
  if (triggerCases.length) stages.push(await runTriggerStage({ skillDesc, cases: triggerCases, thresholds }, onProgress));
  if (taskCases.length) stages.push(await runTaskStage({ skillBody, cases: taskCases, thresholds }, onProgress));
  for (const s of stages) s.scope = scope;
  return stages;
}

async function runTriggerStage({ skillDesc, cases, thresholds }, onProgress) {
  const t0 = Date.now();
  const results = [];
  let judgeBroken = false;
  for (const c of cases) {
    onProgress?.({ phase: 'trigger-evaluation', detail: `用例 ${c.id}` });
    const expect = c.expect === undefined ? c.kind === 'TRIGGER_POSITIVE' : c.expect;
    try {
      const j = await judgeTrigger(skillDesc, c.input);
      results.push({ id: c.id, kind: c.kind, input: clip(c.input, 160), expect, actual: j.trigger, pass: j.trigger === expect, judge: j });
    } catch (e) {
      judgeBroken = true;
      results.push({ id: c.id, kind: c.kind, input: clip(c.input, 160), expect, pass: false, error: clip(String(e.message || e), 300) });
    }
  }
  return finishStage('trigger-evaluation', '触发判定测评', results, thresholds.trigger_accuracy, judgeBroken, t0);
}

async function runTaskStage({ skillBody, cases, thresholds }, onProgress) {
  const t0 = Date.now();
  const results = [];
  let judgeBroken = false;
  let llmBroken = false;
  for (const c of cases) {
    onProgress?.({ phase: 'task-evaluation', detail: `用例 ${c.id}` });
    // 1) 真实跑：SKILL.md 作 system，case.input 作 user
    let output;
    try {
      output = await llm.chat(
        [
          { role: 'system', content: skillBody },
          { role: 'user', content: c.input },
        ],
        { temperature: 0.3, maxTokens: 2000, timeoutMs: 90_000 },
      );
    } catch (e) {
      llmBroken = true;
      results.push({ id: c.id, kind: c.kind, input: clip(c.input, 160), pass: false, error: clip(String(e.message || e), 300) });
      continue;
    }
    // 2) 规则断言合取
    const rules = {
      keywords: c.expected_keywords.filter((k) => output.toLowerCase().includes(k.toLowerCase())),
      keywords_miss: c.expected_keywords.filter((k) => !output.toLowerCase().includes(k.toLowerCase())),
      regex_fail: (c.expected_regex || []).filter((p) => { try { return !(new RegExp(p)).test(output); } catch { return true; } }),
      required_tools_miss: (c.required_tools || []).filter((t) => !output.includes(t)),
      forbidden_hit: (c.forbidden_tools || []).filter((t) => output.includes(t)),
    };
    const rulesPass = !rules.keywords_miss.length && !rules.regex_fail.length && !rules.required_tools_miss.length && !rules.forbidden_hit.length;
    // 3) LLM judge 三维评分；不可用时降级规则合取 + degraded
    let judge = null;
    try {
      judge = await judgeTask(skillBody, c, output);
    } catch {
      judgeBroken = true;
    }
    const pass = judge ? (rulesPass && judge.pass) : rulesPass;
    results.push({
      id: c.id, kind: c.kind, input: clip(c.input, 160), pass, rules,
      judge_missing: !judge, judge: judge ? { semantic: judge.semantic, tools: judge.tools, quality: judge.quality, total: judge.total, reason: judge.reason } : null,
      output: clip(output, 500),
    });
  }
  const st = finishStage('task-evaluation', '任务执行测评', results, thresholds.pass_rate, judgeBroken, t0);
  if (llmBroken && !st.error) st.error = '任务执行阶段 LLM 不可达：检查 LLM_BASE_URL / LLM_API_KEY（healthz 有诊断）';
  return st;
}

function finishStage(stageId, title, results, threshold, judgeBroken, t0) {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const errors = results.filter((r) => r.error).length;
  const degraded = !errors && judgeBroken && results.every((r) => r.pass || r.judge_missing);
  const accuracy = total ? passed / total : 0;
  const status = errors === total ? 'fail' : degraded && accuracy >= threshold ? 'degraded' : accuracy >= threshold && !errors ? 'pass' : 'fail';
  return {
    stage_id: stageId,
    title,
    kind: 'runtime',
    status,
    threshold,
    metrics: { total, passed, accuracy: Math.round(accuracy * 1000) / 1000 },
    cases: results,
    error: errors && errors === total ? (results.find((r) => r.error)?.error || '全部用例执行失败') : null,
    started_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
  };
}
