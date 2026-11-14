import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { validateSkill, loadSkill } from './skill.js';
import { mockProvider } from './providers/mock.js';
import { openaiProvider } from './providers/openai.js';

const PROVIDERS = { mock: mockProvider, openai: openaiProvider };

function findCasesFile(dir) {
  for (const name of ['cases.yaml', 'cases.yml']) {
    const p = path.join(path.resolve(dir), 'evals', name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function runEval(dir, opts = {}) {
  // 先校验，skill 本身有问题就直接别评了
  const { errors, skill } = validateSkill(dir);
  if (errors.length) {
    throw new Error(`skill 校验未通过：\n  - ${errors.join('\n  - ')}`);
  }

  const casesPath = findCasesFile(dir);
  if (!casesPath) {
    throw new Error(`未找到 ${path.resolve(dir)}/evals/cases.yaml`);
  }
  const parsed = parse(fs.readFileSync(casesPath, 'utf8'));
  const cases = parsed?.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new Error(`evals/cases.yaml 里没有用例`);
  }
  for (const [i, c] of cases.entries()) {
    if (!c.id || !c.input) {
      throw new Error(`第 ${i + 1} 条用例缺少 id 或 input`);
    }
  }

  const providerName = opts.provider || 'mock';
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`未知 provider "${providerName}"（可选：${Object.keys(PROVIDERS).join(' | ')}）`);
  }

  console.log(`评测 ${skill.data.name}：${cases.length} 条用例，provider=${providerName}`);
  const startedAt = new Date().toISOString();
  const results = [];
  for (const c of cases) {
    const t0 = Date.now();
    const output = await provider({
      system: skill.content, // SKILL.md 正文当 system prompt，和 agent 加载行为一致
      input: c.input,
    });
    const expects = Array.isArray(c.expect_contains) ? c.expect_contains : [];
    const missing = expects.filter((s) => !output.includes(s));
    const pass = missing.length === 0;
    results.push({
      id: c.id,
      pass,
      missing,
      durationMs: Date.now() - t0,
      output,
    });
    console.log(`  ${pass ? '✓' : '✗'} ${c.id}（${Date.now() - t0}ms）${pass ? '' : ` 缺少关键词: ${missing.join('、')}`}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const report = {
    skill: skill.data.name,
    provider: providerName,
    startedAt,
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };

  // 报告落盘，这是 M3 演化证据链的原料
  const runsDir = path.join(path.resolve(dir), 'evals', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const reportPath = path.join(runsDir, `run-${startedAt.replaceAll(/[:.]/g, '-')}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`${passed}/${results.length} 通过`);
  console.log(`报告：${reportPath}`);
  if (report.failed > 0) {
    throw new Error(`有 ${report.failed} 条用例失败`);
  }
  return report;
}

export async function evalCmd(dir, opts) {
  try {
    await runEval(dir, opts);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exitCode = 1;
  }
}
