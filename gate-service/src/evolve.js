// evolve.js — 技能进化：base eval → 反思重写 → candidate eval → 逐 case 对比 → 采纳结论
// 单轮反思迭代（OntoMind GEPA 精简版）；max_rounds 默认 1
import { llm } from './llm.js';
import { runDataset } from './stages/runtime.js';
import matter from 'gray-matter';

const clip = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

// 摘取某 case 的执行结果（对比用）
function caseMap(stageResults) {
  const map = new Map();
  for (const st of stageResults) for (const c of st.cases || []) map.set(c.id, c);
  return map;
}

// dataset 全量跑（trigger + task）
export async function evalAll({ skillBody, skillDesc, dataset }, onProgress) {
  return runDataset({ skillBody, skillDesc, dataset }, onProgress);
}

// 反思 + 重写 SKILL.md。约束：只允许改正文与 description，name 与其余 frontmatter 不变
export async function reflectRewrite({ frontmatter, body, dataset }, failures, onProgress) {
  const failureText = failures
    .map((c, i) => {
      const judge = c.judge ? `（judge ${c.judge.total}/1：${c.judge.reason}）` : c.judge_missing ? '（judge 缺失，规则断言失败）' : '';
      const miss = c.rules?.keywords_miss?.length ? `，缺关键词：${c.rules.keywords_miss.join('、')}` : '';
      return `${i + 1}. [${c.kind}] 输入：${c.input}\n   期望：${c.expect === undefined ? '任务正确完成' : c.expect ? '应触发' : '不应触发'}${judge}${miss}\n   实际输出：${clip(c.output || c.error, 300)}`;
    })
    .join('\n');
  // holdout：显式标记的 + 所有 base 通过用例（隐式 holdout）。必须带输入与期望，否则 LLM 无法锚定
  const failedIds = new Set(failures.map((c) => c.id));
  const holdoutList = dataset.cases
    .filter((c) => c.holdout || !failedIds.has(c.id))
    .map((c) => `- ${c.id}（${c.kind}，期望${c.expect === undefined ? '任务正确完成' : c.expect ? '应触发' : '不应触发'}）：${clip(c.input, 120)}`)
    .join('\n') || '（无）';

  onProgress?.({ phase: 'evolve-reflect', detail: 'LLM 反思分析失败用例' });
  const data = await llm.chatJson(
    [
      {
        role: 'system',
        content:
          '你是技能进化引擎。给定技能的 frontmatter+正文、失败用例（输入/期望/实际）与 holdout 清单：\n' +
          '1) 诊断失败根因：哪节缺内容/描述模糊/示例误导/边界没写清；\n' +
          '2) 重写 SKILL.md 修复这些问题。\n' +
          '触发判定修复原则（最重要，逐条遵守）：\n' +
          '- 「期望：不应触发」的用例失败 = description 太宽导致误触发。修复方式是收窄 description，明确写出该技能只做什么、不支持什么，让这类输入不再命中。严禁通过给技能增加新能力（把该输入纳入支持范围）来"修复"——那是反向修复，必然造成回归。\n' +
          '- 「期望：应触发」的用例失败 = description 没覆盖该场景。修复方式是在不引入误触发的前提下补充适用场景。\n' +
          '- 重写后：原失败用例必须按其"期望"通过（不应触发的不再触发，应触发的仍然触发）；所有 holdout 用例不得回归——description 必须能命中每个"应触发"holdout 的输入场景。\n' +
          '硬约束：只允许修改正文与 frontmatter 中的 description；name 及其余 frontmatter 字段必须原样保留；正文必须保留原有 5 章节结构。\n' +
          '输出格式：skill_md 必须是标准 SKILL.md——首行为单个 ---，frontmatter 结束后再以单个 --- 分隔正文；不得出现连续两行 --- 或多余分隔线。\n' +
          '只输出 JSON：{"diagnosis": ["诊断点1", "诊断点2"], "skill_md": "重写后的完整 SKILL.md 全文（含 frontmatter）"}',
      },
      {
        role: 'user',
        content:
          `【当前 SKILL.md】\n${frontmatter}${body}\n\n` +
          `【失败用例】\n${failureText}\n\n` +
          `【holdout 用例（不得回归；重写后的 description 必须覆盖所有"应触发"用例的场景，同时排除所有"不应触发"用例）】\n${holdoutList}\n\n` +
          `请诊断并重写。`,
      },
    ],
    { temperature: 0.3, maxTokens: 4000, timeoutMs: 120_000 },
  );
  return {
    diagnosis: Array.isArray(data.diagnosis) ? data.diagnosis.map(String) : [String(data.diagnosis || '')],
    candidateMd: String(data.skill_md || ''),
  };
}

// 对比 base 与 candidate 的逐 case 结果 → {fixed, regressed, still_failing, adoptable}
export function compareResults(baseCases, candCases, dataset) {
  const base = caseMap(baseCases);
  const cand = caseMap(candCases);
  const originalFailing = [...base.entries()].filter(([, c]) => !c.pass);
  const fixed = originalFailing.filter(([id]) => cand.get(id)?.pass).map(([id]) => id);
  const stillFailing = originalFailing.filter(([id]) => !cand.get(id)?.pass).map(([id]) => id);
  const regressed = [...base.entries()]
    .filter(([id, c]) => c.pass && cand.get(id) && !cand.get(id).pass)
    .map(([id]) => id);
  // 采纳标准：原失败全修复 ∧ 零回归（holdout 回归一票否决，已含在 regressed 判定内）
  const adoptable = stillFailing.length === 0 && regressed.length === 0;
  return { fixed, regressed, still_failing: stillFailing, adoptable };
}

// 复评消噪（OntoMind baseline 思路）：对存疑判定复评 extra 次，多数投票定论，避免 judge 抖动误判
async function stablePass({ skillBody, skillDesc, dataset }, caseItem, firstPass, onProgress, extra = 2) {
  const votes = [Boolean(firstPass)];
  const subset = { scope: dataset.scope, thresholds: dataset.thresholds, cases: [caseItem] };
  for (let i = 0; i < extra; i++) {
    const stages = await evalAll({ skillBody, skillDesc, dataset: subset }, onProgress);
    const c = stages.flatMap((s) => s.cases || []).find((x) => x.id === caseItem.id);
    votes.push(Boolean(c?.pass));
  }
  return votes.filter(Boolean).length * 2 > votes.length;
}

// 完整进化流程（多轮反思迭代 + 复评消噪）→ job 结果对象（server 层负责落盘与 job_id）
export async function runEvolve({ files, dataset, maxRounds = 3 }, onProgress = () => {}) {
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (!skillMd) throw new Error('包内缺少 SKILL.md，无法进化');

  // frontmatter 原样保留 + 正文
  const fmMatch = skillMd.text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const frontmatter = fmMatch ? fmMatch[0] : '---\nname: unknown\n---\n';
  const origName = (frontmatter.match(/name:\s*(.+)/) || [, ''])[1].trim();
  const desc = String(matter(skillMd.text).data?.description || '').trim();

  onProgress?.({ phase: 'evolve-base', detail: 'base eval：dataset 全量' });
  const baseStages = await evalAll({ skillBody: skillMd.text, skillDesc: desc, dataset }, onProgress);

  // base 消噪：失败 case 复评 2 次多数投票——抖动 case 不进入修复目标；定论作为全程对比锚点
  const baseVerdict = new Map();
  for (const c of baseStages.flatMap((s) => s.cases || [])) {
    let pass = Boolean(c.pass);
    if (!pass) {
      onProgress?.({ phase: 'evolve-denoise', detail: `base 复评 ${c.id}` });
      pass = await stablePass({ skillBody: skillMd.text, skillDesc: desc, dataset }, c, pass, onProgress);
    }
    baseVerdict.set(c.id, { pass, case: c });
  }
  const rounds = [];
  if (![...baseVerdict.values()].some((v) => !v.pass)) {
    rounds.push({ round: 1, base: baseStages, failures: [] });
    return { status: 'done', conclusion: 'no_need', rounds, message: 'base eval 全部通过（含复评消噪），无需进化' };
  }

  // 迭代：每轮以上轮候选为新基线；采纳标准始终锚定原始判定（原失败全修复 ∧ 零回归 ∧ name 冻结）
  let curFm = frontmatter;
  let curBody = skillMd.text.slice(frontmatter.length);
  let curDesc = desc;
  let pending = [...baseVerdict.entries()].filter(([, v]) => !v.pass);
  let conclusion = 'rejected';
  let message = '';

  for (let roundNo = 1; roundNo <= Math.max(1, maxRounds); roundNo++) {
    const round = { round: roundNo, failures: pending.map(([id]) => id) };
    if (roundNo === 1) round.base = baseStages;

    const { diagnosis, candidateMd: rawMd } = await reflectRewrite(
      { frontmatter: curFm, body: curBody, dataset },
      pending.map(([, v]) => v.case),
      onProgress,
    );
    round.diagnosis = diagnosis;
    // 防御性规整：LLM 偶发复制 prompt 里的重复 --- 分隔线，会使 frontmatter 解析为空
    const candidateMd = rawMd.replace(/^---[ \t]*\r?\n[ \t]*---[ \t]*\r?\n/, '---\n');
    round.candidate_md = candidateMd;
    if (!candidateMd.trim()) {
      conclusion = 'rewrite_failed';
      message = '进化重写失败：LLM 未返回有效 SKILL.md';
      break;
    }

    // candidate frontmatter 校验：name 冻结 + description 可解析
    const candFm = candidateMd.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    const candName = candFm ? ((candFm[0].match(/name:\s*(.+)/) || [, ''])[1].trim()) : '';
    round.name_preserved = candName === origName;
    const candDesc = String(matter(candidateMd).data?.description || '').trim();
    if (!candDesc) {
      conclusion = 'rewrite_failed';
      message = '进化重写失败：候选 SKILL.md frontmatter 无法解析（缺少 description）';
      break;
    }

    onProgress?.({ phase: 'evolve-candidate', detail: `candidate eval：第 ${roundNo} 轮复测` });
    const candStages = await evalAll({ skillBody: candidateMd, skillDesc: candDesc, dataset }, onProgress);

    // candidate 消噪：只复评「与原判定翻转」的 case（判定一致视为稳定）
    const candVerdict = new Map();
    for (const c of candStages.flatMap((s) => s.cases || [])) {
      let pass = Boolean(c.pass);
      if (pass !== baseVerdict.get(c.id)?.pass) {
        onProgress?.({ phase: 'evolve-denoise', detail: `candidate 复评 ${c.id}` });
        pass = await stablePass({ skillBody: candidateMd, skillDesc: candDesc, dataset }, c, pass, onProgress);
      }
      candVerdict.set(c.id, pass);
    }

    // 对比（锚定原始判定）：fixed/regressed/still_failing
    const fixed = [];
    const still = [];
    const regressed = [];
    for (const [id, v] of baseVerdict) {
      const cp = candVerdict.get(id);
      if (cp === undefined) continue;
      if (!v.pass && cp) fixed.push(id);
      else if (!v.pass && !cp) still.push(id);
      else if (v.pass && !cp) regressed.push(id);
    }
    const adoptable = still.length === 0 && regressed.length === 0 && round.name_preserved;
    round.candidate = candStages;
    round.compare = { fixed, regressed, still_failing: still, adoptable };
    round.summary = `修复 ${fixed.length}/${round.failures.length}，回归 ${regressed.length}，仍失败 ${still.length}`;
    rounds.push(round);

    if (adoptable) {
      conclusion = 'adoptable';
      message = `第 ${roundNo} 轮进化候选可采纳：${round.summary}。采纳后自动重走检查扫描/测评。`;
      break;
    }
    // REFLECT stop：本轮零修复 → 继续轮大概率重复，提前停止
    if (fixed.length === 0) {
      message = `第 ${roundNo} 轮进化无进展（${round.summary}${round.name_preserved ? '' : '；name 被改动'}），已拒绝。`;
      break;
    }
    // 以候选为新基线，继续修复剩余失败 + 回归用例（反馈给 LLM 针对性修复）
    pending = [...baseVerdict.entries()].filter(([id, v]) => (!v.pass && still.includes(id)) || regressed.includes(id));
    curFm = candFm || curFm;
    curBody = candidateMd.slice(candFm ? candFm[0].length : 0);
    curDesc = candDesc;
  }

  if (!message) message = `进化候选不满足采纳标准（${Math.max(1, maxRounds)} 轮内未达成全修复+零回归），已拒绝。`;
  return { status: 'done', conclusion, rounds, message };
}
