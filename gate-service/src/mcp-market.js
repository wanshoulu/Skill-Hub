// mcp-market.js — MCP 市场：目录 → 安装 → 探测 → 试跑 → 技能依赖体检
//
// 设计要点（与 skill 创建/发布/运行协同的地基）：
// 1. 注册表里由市场装入的服务器带 catalog_id，卸载按 catalog_id 精确回收；
// 2. 安装是幂等的：同名已存在就不覆盖（用户手工改过的配置优先）；
// 3. npx 冷启动要下包，慢且不确定，因此安装只登记 + 后台预热，探测/体检读缓存，
//    绝不让一次 HTTP 请求卡在 npm 安装上；
// 4. 技能声明（SKILL.md 的 mcp_tools）只写 server 名 + 勾选的 tool 名，
//    连接信息与凭据一律留在网关侧。
import {
  getCatalog, listMcpServers, addMcpServer, removeMcpServer, updateMcpServer,
  getMcpServer, probeMcpServer, probeState, invalidateProbe,
} from './mcp.js';

const WARM_BUDGET_MS = Number(process.env.MCP_WARM_BUDGET_MS || 180_000);

// 后台预热：安装完立刻拉起一次，把 npx 安装/握手成本从用户请求路径挪走
const warming = new Map(); // serverId → started_at

function warm(id) {
  if (warming.has(id)) return;
  warming.set(id, Date.now());
  probeMcpServer(id, { force: true, connectTimeoutMs: WARM_BUDGET_MS, listTimeoutMs: 30_000 })
    .catch(() => {})
    .finally(() => warming.delete(id));
}

export function isWarming(id) {
  return warming.has(id);
}

export function findByName(name) {
  return listMcpServers().find((s) => s.name === name) || null;
}

export function catalogItem(id) {
  return getCatalog().find((c) => c.id === id) || null;
}

// 预置项 → 注册表配置（可被 env / args 覆盖）
function presetToConfig(preset, patch = {}) {
  const env = { ...(preset.env || {}), ...(patch.env || {}) };
  return {
    name: patch.name || preset.name,
    transport: preset.transport || 'stdio',
    command: patch.command || preset.command,
    args: patch.args || preset.args || [],
    env,
    url: patch.url || preset.url,
    headers: patch.headers || preset.headers || {},
    enabled: patch.enabled !== false,
    catalog_id: preset.id,
    description: preset.description,
    category: preset.category,
    registry: preset.registry,
    requires_env: preset.requires_env || [],
  };
}

// 凭据是否已填齐（缺 key 的预置装上也只能算"待配置"，不能算可用）
function envReady(server, preset) {
  const need = (preset?.requires_env || server.requires_env || []);
  const missing = need.filter((k) => !String(server.env?.[k] ?? '').trim());
  return { ok: missing.length === 0, missing };
}

// 单个注册表条目的健康摘要（读缓存，不触发探测）
export function serverHealth(server) {
  if (server.enabled === false) return { state: 'disabled', label: '已禁用', tools: 0 };
  if (warming.has(server.id)) return { state: 'probing', label: '首次安装/连接中', tools: 0 };
  const st = probeState(server.id);
  if (!st) return { state: 'unknown', label: '未探测', tools: 0 };
  if (st.status === 'online') return { state: 'online', label: '在线', tools: st.tools.length };
  if (st.status === 'disabled') return { state: 'disabled', label: '已禁用', tools: 0 };
  return { state: 'error', label: '异常', tools: 0, error: st.error };
}

// ── 目录视图（市场页/侧栏的数据源）───────────────────────────────
export function catalogView() {
  const servers = listMcpServers();
  const byCatalog = new Map();
  const byName = new Map();
  for (const s of servers) {
    if (s.catalog_id) byCatalog.set(s.catalog_id, s);
    byName.set(s.name, s);
  }
  return getCatalog().map((preset) => {
    const server = byCatalog.get(preset.id) || byName.get(preset.name) || null;
    if (!server) {
      return {
        ...preset, installed: false, server_id: null, state: 'absent', label: '未安装',
        tools: 0, needs_config: (preset.requires_env || []).length > 0,
      };
    }
    const { ok, missing } = envReady(server, preset);
    const h = serverHealth(server);
    return {
      ...preset,
      installed: true,
      server_id: server.id,
      state: ok ? h.state : 'needs_config',
      label: ok ? h.label : `待配置（缺 ${missing.join('、')}）`,
      tools: ok ? h.tools : 0,
      error: ok ? h.error : `缺少环境变量：${missing.join('、')}`,
      needs_config: !ok,
      missing_env: missing,
    };
  });
}

// ── 安装 / 卸载 ──────────────────────────────────────────────────
export function installFromCatalog(catalogId, patch = {}) {
  const preset = catalogItem(catalogId);
  if (!preset) throw Object.assign(new Error(`市场中没有该预置：${catalogId}`), { status: 404 });
  const existing = findByName(patch.name || preset.name);
  if (existing) {
    // 同名已存在：只在显式要求时补齐凭据，不覆盖用户配置
    let server = existing;
    const incomingEnv = patch.env || {};
    if (Object.keys(incomingEnv).length) {
      invalidateProbe(existing.id);
      server = updateMcpServer(existing.id, { env: { ...(existing.env || {}), ...incomingEnv } });
    }
    if (!server.catalog_id) server = updateMcpServer(existing.id, { catalog_id: preset.id });
    if (server.enabled === false && patch.enabled !== false) updateMcpServer(existing.id, { enabled: true });
    warm(existing.id);
    return { server, already: true, warming: true };
  }
  const server = addMcpServer(presetToConfig(preset, patch));
  warm(server.id);
  return { server, already: false, warming: true };
}

export function installMany(items = []) {
  const installed = [], existing = [], failed = [];
  for (const it of items) {
    const id = typeof it === 'string' ? it : it?.catalog_id || it?.id;
    const patch = typeof it === 'string' ? {} : (it?.env || it?.args ? { env: it.env, args: it.args } : {});
    if (!id) { failed.push({ id: null, error: '缺少 catalog id' }); continue; }
    try {
      const r = installFromCatalog(id, patch);
      (r.already ? existing : installed).push({ catalog_id: id, server: r.server });
    } catch (e) {
      failed.push({ id, error: String(e.message || e) });
    }
  }
  return { installed, existing, failed };
}

export function uninstallCatalog(catalogId) {
  const server = listMcpServers().find((s) => s.catalog_id === catalogId || s.name === catalogItem(catalogId)?.name);
  if (!server) return { removed: null };
  invalidateProbe(server.id);
  removeMcpServer(server.id);
  return { removed: server.id };
}

// 创建期协同：命中的市场预置自动装进注册表，返回可探测的真实绑定
// binding 形态与前端勾绑定一致：{server_id, server_name, tool_names}
// 返回值与入参**等长且同序**（失败位为 null），调用方才能安全按下标对齐
export function ensureInstalled(presets) {
  const bindings = [];
  const events = [];
  for (const p of presets || []) {
    const preset = catalogItem(p?.id || p?.catalog_id || p?.server_id);
    if (!preset) {
      // 不是市场预置：可能前端已手工注册过同名服务器，直接沿用
      const existing = p?.server_id ? getMcpServer(p.server_id) : findByName(p?.server_name || p?.name);
      if (existing) {
        bindings.push({ server_id: existing.id, server_name: existing.name, tool_names: p?.tool_names || [] });
        events.push({ catalog_id: null, name: existing.name, action: 'existing', server_id: existing.id });
      } else {
        bindings.push(null);
        events.push({ catalog_id: p?.id || p?.server_id || null, name: p?.name || p?.server_name || null, action: 'unknown', error: '市场中没有该预置，注册表里也没有同名服务器' });
      }
      continue;
    }
    try {
      const r = installFromCatalog(preset.id, {});
      bindings.push({ server_id: r.server.id, server_name: r.server.name, tool_names: [] });
      events.push({ catalog_id: preset.id, name: preset.name, action: r.already ? 'existing' : 'installed', server_id: r.server.id });
    } catch (e) {
      bindings.push(null);
      events.push({ catalog_id: preset.id, name: preset.name, action: 'failed', error: String(e.message || e) });
    }
  }
  return { bindings, events };
}

// ── 工具试跑（市场"立即验证"与创建期真实性校验）─────────────────
export async function callMcpTool(serverId, toolName, args = {}, { timeoutMs = 45_000 } = {}) {
  const server = getMcpServer(serverId);
  if (!server) throw Object.assign(new Error(`MCP 服务器不存在：${serverId}`), { status: 404 });
  if (server.enabled === false) throw Object.assign(new Error('服务器已禁用'), { status: 409 });
  let client = null;
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  try {
    if (server.transport === 'stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const transport = new StdioClientTransport({
        command: server.command, args: server.args || [], env: { ...process.env, ...server.env }, stderr: 'pipe',
      });
      client = new Client({ name: 'gate-service', version: '0.1.0' }, { capabilities: {} });
      await withDeadline(client.connect(transport), WARM_BUDGET_MS, '连接');
    } else if (server.transport === 'sse') {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      client = new Client({ name: 'gate-service', version: '0.1.0' }, { capabilities: {} });
      await withDeadline(client.connect(new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers || {} } })), 20_000, '连接');
    } else {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      client = new Client({ name: 'gate-service', version: '0.1.0' }, { capabilities: {} });
      await withDeadline(client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers || {} } })), 20_000, '连接');
    }
    const res = await withDeadline(client.callTool({ name: toolName, arguments: args }), timeoutMs, '调用');
    return {
      server_id: serverId, server: server.name, tool: toolName,
      is_error: Boolean(res?.isError),
      content: (res?.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n').slice(0, 8000),
      structured: res?.structuredContent ?? null,
    };
  } finally {
    if (client) { try { await client.close(); } catch {} }
  }
}

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms); }),
  ]);
}

// ── 依赖体检：技能声明 → 注册表 → 在线状态 ───────────────────────
export async function checkDeps(declarations, { probe = true } = {}) {
  const servers = listMcpServers();
  const byName = new Map(servers.map((s) => [s.name, s]));
  const wanted = new Map(); // server → Set(tool)
  for (const d of declarations) {
    if (!d?.server) continue;
    if (!wanted.has(d.server)) wanted.set(d.server, new Set());
    if (d.tool) wanted.get(d.server).add(d.tool);
  }
  const rows = [];
  for (const [name, toolSet] of wanted) {
    const server = byName.get(name);
    const row = {
      server: name,
      tools: [...toolSet],
      installed: Boolean(server),
      server_id: server?.id || null,
      catalog_id: server?.catalog_id || null,
      enabled: server ? server.enabled !== false : false,
      state: 'missing',
      error: null,
      missing_env: [],
    };
    if (server) {
      const preset = server.catalog_id ? catalogItem(server.catalog_id) : null;
      const { ok, missing } = envReady(server, preset);
      row.missing_env = missing;
      if (!ok) row.state = 'needs_config';
      else if (server.enabled === false) row.state = 'disabled';
      else if (probe) {
        const st = await probeMcpServer(server.id);
        row.state = st.status === 'online' ? 'online' : 'error';
        row.error = st.status === 'online' ? null : st.error;
        const have = new Set(st.tools.map((t) => t.name));
        row.absent_tools = row.tools.filter((t) => !have.has(t));
        row.available_tools = st.tools.map((t) => t.name);
      } else {
        row.state = serverHealth(server).state;
      }
    }
    rows.push(row);
  }
  const bad = rows.filter((r) => r.state === 'missing');
  const warn = rows.filter((r) => ['error', 'needs_config', 'disabled'].includes(r.state));
  const autoInstallable = bad.map((r) => getCatalog().find((c) => c.name === r.server)?.id).filter(Boolean);
  return {
    servers: rows,
    summary: {
      total: rows.length,
      online: rows.filter((r) => r.state === 'online').length,
      missing: bad.length,
      degraded: warn.length,
      auto_installable: autoInstallable,
    },
  };
}

// 绑定 → SKILL.md 的 mcp_tools 声明（确定性，不依赖 LLM 自觉）
// 勾选了具体工具就逐条写；未勾选=整个服务器（与运行侧"tool 省略取全部"语义一致）
export function declarationsFromBindings(bindings) {
  const out = [];
  const seen = new Set();
  for (const b of bindings || []) {
    const server = b?.server_name || b?.name;
    if (!server) continue;
    const tools = (b?.tool_names || []).filter(Boolean);
    if (!tools.length) {
      const key = `${server}\u0000`;
      if (!seen.has(key)) { seen.add(key); out.push({ server, tool: '' }); }
    } else {
      for (const t of tools) {
        const key = `${server}\u0000${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ server, tool: t });
      }
    }
  }
  return out.sort((a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool));
}
