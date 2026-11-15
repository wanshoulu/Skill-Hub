// mcp-flow.js — MCP 市场与技能流水线（创建 / 门禁 / 测评 / 进化）的衔接层
//
// 一条链路四种场景，绑定的唯一真相源是 drafts/:id/meta.json 的 mcp_bindings：
//   创建  → 命中市场预置则自动装入注册表，绑定落 meta，提示词用真实工具签名
//   发布  → 打包时把绑定机械写入 SKILL.md 的 mcp_tools（运行侧只认这个声明）
//   门禁  → 声明 → 注册表 → 探测，产出「MCP 依赖检查」stage
//   进化  → 采纳候选正文后回填声明，避免模型重写时丢掉依赖
import { readJson, saveJson } from './store.js';
import { checkDeps, declarationsFromBindings, installMany } from './mcp-market.js';
import { parseMcpTools, injectMcpTools } from './mcp-skillmd.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

export function draftBindings(id) {
  if (!id) return [];
  const meta = readJson(`drafts/${id}/meta.json`);
  return Array.isArray(meta?.mcp_bindings) ? meta.mcp_bindings : [];
}

// 绑定清洗：只保留能落到注册表真实条目的绑定
// （创建期前端可能带回来 preset.* 这类"还没安装的候选 id"，装完才有 mcp_ 前缀）
export function normalizeBindings(bindings) {
  const map = new Map();
  for (const b of bindings || []) {
    const serverName = b?.server_name || b?.name;
    const serverId = b?.server_id || b?.id;
    if (!serverName || !serverId || /^preset\./.test(String(serverId))) continue;
    const prev = map.get(serverName) || { server_id: serverId, server_name: serverName, tool_names: [] };
    const set = new Set(prev.tool_names);
    for (const t of b.tool_names || []) if (t) set.add(t);
    prev.tool_names = [...set].sort();
    map.set(serverName, prev);
  }
  return [...map.values()].sort((a, b) => a.server_name.localeCompare(b.server_name));
}

export function draftDeclarations(id) {
  return declarationsFromBindings(draftBindings(id));
}

// 合并绑定：按 server_name 归并，tool_names 取并集；incoming 为空时只回读不落盘
export function mergeBindings(id, incoming = []) {
  const current = draftBindings(id);
  const map = new Map();
  for (const b of [...current, ...incoming]) {
    const name = b?.server_name || b?.name;
    if (!name) continue;
    const prev = map.get(name) || { server_id: b.server_id || null, server_name: name, tool_names: [] };
    if (b.server_id) prev.server_id = b.server_id;
    const set = new Set(prev.tool_names);
    for (const t of b.tool_names || []) if (t) set.add(t);
    prev.tool_names = [...set].sort();
    map.set(name, prev);
  }
  const merged = [...map.values()].sort((a, b) => a.server_name.localeCompare(b.server_name));
  const changed = JSON.stringify(merged) !== JSON.stringify(sortDeep(current));
  if (changed) {
    const meta = readJson(`drafts/${id}/meta.json`);
    if (meta) {
      meta.mcp_bindings = merged;
      meta.updated_at = Date.now();
      saveJson(`drafts/${id}/meta.json`, meta);
    }
  }
  return { bindings: merged, changed };
}

function sortDeep(list) {
  return [...list]
    .sort((a, b) => String(a.server_name).localeCompare(String(b.server_name)))
    .map((b) => ({ ...b, tool_names: [...(b.tool_names || [])].sort() }));
}

// 生效声明 = SKILL.md 已写的 ∪ 网关登记的（打包时再并集写入，两边都不会丢）
export function effectiveDeclarations({ markdown = '', bindings = [] } = {}) {
  const fromMd = markdown ? parseMcpTools(markdown) : [];
  const fromGate = declarationsFromBindings(bindings);
  const seen = new Set();
  const out = [];
  for (const d of [...fromGate, ...fromMd]) {
    const k = `${d.server}\u0000${d.tool}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out.sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool));
}

// 门禁 stage：技能声明所依赖的 MCP 是否真的可用
// 缺服务器 = fail（技能装上必然没有工具，属于不可发布的硬伤）
// 探测异常 / 待填凭据 / 已禁用 = warn（多为环境或账号问题，不阻断发布）
export async function mcpDepsStage({ markdown, bindings, autoInstall = true, probe = true }) {
  const decls = effectiveDeclarations({ markdown, bindings });
  if (!decls.length) {
    return {
      stage_id: 'mcp-deps', title: 'MCP 依赖检查', kind: 'mcp', status: 'skipped', threshold: null,
      metrics: { declared: 0 }, cases: [],
      findings: [{ level: 'info', rule: 'mcp-not-declared', message: '技能未声明 MCP 工具依赖，跳过检查' }],
    };
  }
  let deps = await checkDeps(decls, { probe });
  const autoInstalled = [];
  if (autoInstall && deps.summary.missing > 0) {
    const ids = deps.summary.auto_installable;
    if (ids.length) {
      for (const r of installMany(ids.map((id) => ({ id }))).installed) autoInstalled.push(r.server?.name);
      if (autoInstalled.length) {
        // 不在此处等待首次 npx 拉包（可能几分钟），只读后台预热状态，
        // 让门禁给出"已自动安装、稍后复查"的结论而不是把请求挂住
        deps = await checkDeps(decls, { probe: false });
      }
    }
  }
  const rows = deps.servers;
  const missing = rows.filter((r) => r.state === 'missing');
  const degraded = rows.filter((r) => ['error', 'needs_config', 'disabled', 'probing', 'unknown'].includes(r.state));
  const online = rows.filter((r) => r.state === 'online');
  const toolGaps = rows.flatMap((r) => (r.absent_tools || []).map((t) => `${r.server}.${t}`));

  const findings = [];
  for (const r of missing) {
    findings.push({
      level: 'fail', rule: 'mcp-server-missing',
      message: `${r.server}：注册表中没有该 MCP 服务器，技能装上后不会有任何工具`,
    });
  }
  for (const r of degraded) {
    const msg = r.state === 'needs_config'
      ? `${r.server}：缺少凭据 ${r.missing_env.join('、')}，请在 MCP 市场补配`
      : r.state === 'disabled'
        ? `${r.server}：已禁用，运行侧不会注入其工具`
        : r.state === 'probing'
          ? `${r.server}：${autoInstalled.includes(r.server) ? '市场已自动安装，首次拉包/握手进行中' : '首次连接进行中'}，请稍后重跑检查`
          : `${r.server}：${r.error || '未探测'}`;
    findings.push({ level: 'warn', rule: `mcp-${r.state}`, message: msg });
  }
  if (toolGaps.length) {
    findings.push({ level: 'warn', rule: 'mcp-tool-absent', message: `声明的工具在服务器上不存在：${toolGaps.join('、')}` });
  }
  if (!findings.length) {
    findings.push({
      level: 'pass', rule: 'mcp-deps-ok',
      message: `${online.length}/${rows.length} 个 MCP 服务器在线，共 ${decls.length} 条工具声明`,
    });
  }
  const status = missing.length && !autoInstalled.length ? 'fail' : missing.length ? 'warn' : degraded.length || toolGaps.length ? 'warn' : 'pass';
  return {
    stage_id: 'mcp-deps', title: 'MCP 依赖检查', kind: 'mcp', status, threshold: null,
    metrics: {
      declared: decls.length, servers: rows.length, online: online.length,
      missing: missing.length, degraded: degraded.length, auto_installed: autoInstalled.length,
    },
    deps, cases: [], findings,
  };
}

// ── 创建期推荐的"领养"索引 ──────────────────────────────────────
// 首轮创建通常还没有 draft_id（前端拿到产物才建草稿），绑定必须跨这一步传下去。
// 按技能名存一份短生命周期的推荐结果，POST /v1/drafts 保存时若调用方没带绑定就接管。
const PENDING_TTL_MS = 7 * 24 * 3600 * 1000;

function pendingPath(name) {
  const h = crypto.createHash('sha1').update(String(name).toLowerCase()).digest('hex').slice(0, 16);
  return `mcp_pending/${h}.json`;
}

export function rememberRecommendation(name, bindings) {
  const clean = (bindings || []).filter((b) => b?.server_id && b?.server_name);
  if (!clean.length) return;
  saveJson(pendingPath(name), { name, bindings: mergeMap(clean), created_at: Date.now() });
}

export function adoptRecommendation(name) {
  const rec = readJson(pendingPath(name));
  if (!rec?.bindings?.length) return [];
  if (Date.now() - (rec.created_at || 0) > PENDING_TTL_MS) return [];
  if (String(rec.name) !== String(name)) return [];
  return rec.bindings;
}

export function forgetRecommendation(name) {
  saveJson(pendingPath(name), { name, bindings: [], created_at: 0 });
}

function mergeMap(bindings) {
  const map = new Map();
  for (const b of bindings) {
    const prev = map.get(b.server_name) || { server_id: b.server_id, server_name: b.server_name, tool_names: [] };
    if (b.server_id) prev.server_id = b.server_id;
    const set = new Set(prev.tool_names);
    for (const t of b.tool_names || []) if (t) set.add(t);
    prev.tool_names = [...set].sort();
    map.set(b.server_name, prev);
  }
  return [...map.values()].sort((a, b) => a.server_name.localeCompare(b.server_name));
}

// 采纳/保存正文时回填声明，保证磁盘上的 SKILL.md 自描述
export function syncSkillMd(dirPath, bindings) {
  const decls = declarationsFromBindings(bindings);
  if (!decls.length) return { changed: false, added: [] };
  const file = `${dirPath}/SKILL.md`;
  const md = fs.readFileSync(file, 'utf8');
  const r = injectMcpTools(md, decls);
  if (r.changed) fs.writeFileSync(file, r.markdown, 'utf8');
  return r;
}
