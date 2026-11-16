// mcp.js — MCP 服务器注册表 + 工具探测客户端 + 预置市场目录
// 支持 stdio / sse / streamable-http 三种传输
import { saveJson, readJson } from './store.js';
import { llm } from './llm.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_PATH = 'mcp_servers.json';
const STATUS_TTL_MS = 5 * 60 * 1000; // 探测结果缓存 5 分钟

// ── 预置市场目录 ─────────────────────────────────────────────────

let _catalogCache = null;

export function getCatalog() {
  if (_catalogCache) return _catalogCache;
  try {
    const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-catalog.json');
    _catalogCache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    _catalogCache = [];
  }
  return _catalogCache;
}

// 根据用户消息匹配预置 MCP 工具（关键词命中法，无需 LLM）
export function recommendFromCatalog(message, maxResults = 5) {
  const catalog = getCatalog();
  if (!catalog.length) return [];
  const msg = message.toLowerCase();
  const scored = [];
  for (const item of catalog) {
    let hits = 0;
    for (const kw of item.keywords || []) {
      if (msg.includes(kw.toLowerCase())) hits++;
    }
    if (hits > 0) scored.push({ ...item, score: hits });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(({ score, ...rest }) => rest);
}

// 语义匹配：LLM 理解任务语义后从预置目录挑选工具（比关键词命中更准）。
// LLM 判定"无匹配"返回空数组（纯本地任务不硬塞工具）；LLM 失败/超时回落关键词兜底。
export async function recommendFromCatalogSemantic(message, maxResults = 3) {
  const catalog = getCatalog();
  if (!catalog.length || !llm.configured) return recommendFromCatalog(message, maxResults);
  try {
    const listing = catalog.map(c => ({
      id: c.id,
      name: c.display_name || c.name,
      description: c.description,
      keywords: c.keywords,
    }));
    const data = await llm.chatJson(
      [
        {
          role: 'system',
          content:
            '你是 MCP 工具推荐器。根据用户的技能任务描述，从候选工具列表中选出能提供任务所需数据或外部能力的工具（最多 ' + maxResults + ' 个）。\n' +
            '判断标准：任务是否真的需要该工具提供的数据/能力（如实时行情、网页抓取、数据库、搜索）。\n' +
            '纯本地文本处理类任务（总结、翻译、改写等）不需要外部工具，返回空数组。\n' +
            '只输出 JSON：{"ids": ["候选工具id", ...]}',
        },
        { role: 'user', content: `任务：${message}\n\n候选工具：${JSON.stringify(listing)}` },
      ],
      { timeoutMs: 20_000 },
    );
    const ids = Array.isArray(data?.ids) ? data.ids : [];
    return ids
      .map(id => catalog.find(c => c.id === id))
      .filter(Boolean)
      .slice(0, maxResults);
  } catch {
    return recommendFromCatalog(message, maxResults); // LLM 失败 → 关键词兜底
  }
}

// ── 注册表 CRUD ──────────────────────────────────────────────────

export function listMcpServers() {
  return readJson(REGISTRY_PATH) || [];
}

export function getMcpServer(id) {
  return listMcpServers().find(s => s.id === id) || null;
}

export function addMcpServer(config) {
  const servers = listMcpServers();
  const name = (config.name || '').trim();
  if (!name) throw Object.assign(new Error('需要服务器名称'), { status: 400 });
  // 重名校验：技能按 server 名引用配置，重名会让 agent 侧解析到"最后一条"，必须拒绝
  if (servers.some(s => s.name === name)) {
    throw Object.assign(new Error(`MCP 服务器名称已存在：${name}`), { status: 409 });
  }
  const server = {
    id: `mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    transport: config.transport || 'stdio',
    command: config.command || undefined,
    args: config.args || [],
    env: config.env || {},
    url: config.url || undefined,
    headers: config.headers || {},
    enabled: config.enabled !== false,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  servers.push(server);
  saveJson(REGISTRY_PATH, servers);
  return server;
}

const MCP_TRANSPORTS = new Set(['stdio', 'sse', 'streamable-http']);

// 校验合并后的服务器配置：transport 枚举 + stdio 需 command / 远程需合法 http(s) url
function validateServerConfig(cfg) {
  const transport = cfg.transport || 'stdio';
  if (!MCP_TRANSPORTS.has(transport)) {
    throw Object.assign(new Error(`不支持的传输类型：${transport}（仅支持 stdio / sse / streamable-http）`), { status: 400 });
  }
  if (transport === 'stdio') {
    if (!cfg.command || !String(cfg.command).trim()) {
      throw Object.assign(new Error('stdio 传输需要 command'), { status: 400 });
    }
  } else {
    let url;
    try { url = new URL(cfg.url); } catch {
      throw Object.assign(new Error('远程传输需要合法的 http(s) url'), { status: 400 });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw Object.assign(new Error('url 仅支持 http/https 协议'), { status: 400 });
    }
  }
  for (const k of ['args', 'env', 'headers']) {
    if (cfg[k] === undefined || cfg[k] === null) continue;
    if (k === 'args' ? !Array.isArray(cfg[k]) : typeof cfg[k] !== 'object' || Array.isArray(cfg[k])) {
      throw Object.assign(new Error(`字段 ${k} 类型不合法`), { status: 400 });
    }
  }
}

export function updateMcpServer(id, patch) {
  const servers = listMcpServers();
  const idx = servers.findIndex(s => s.id === id);
  if (idx < 0) throw Object.assign(new Error(`MCP 服务器不存在：${id}`), { status: 404 });
  // 字段白名单：name 不可改（技能按名引用，改了会让引用悬空）；id/created_at 系统管理
  const cleanPatch = {};
  for (const k of ['transport', 'command', 'args', 'env', 'url', 'headers', 'enabled']) {
    if (k in patch) cleanPatch[k] = patch[k];
  }
  // 合并现有配置后整体校验（兼容只改 enabled 的部分更新），再按 transport 清掉无关字段残留
  const merged = { ...servers[idx], ...cleanPatch };
  validateServerConfig(merged);
  if (merged.transport === 'stdio') { merged.url = undefined; merged.headers = {}; }
  else { merged.command = undefined; merged.args = []; }
  servers[idx] = { ...merged, id, updated_at: Date.now() };
  saveJson(REGISTRY_PATH, servers);
  return servers[idx];
}

export function removeMcpServer(id) {
  const servers = listMcpServers().filter(s => s.id !== id);
  saveJson(REGISTRY_PATH, servers);
}

// ── 工具探测（带缓存）────────────────────────────────────────────

const probeCache = new Map(); // serverId → { status, tools, error, probed_at }

// 探测超时：connect 与 listTools 各 60s，与 agent 侧 CONNECT_TIMEOUT(60s) 对齐。
// npx 类 stdio 服务器首次冷启动要下载包，15s 必然误报；connect 不设超时则探测请求会无限挂起
const PROBE_CONNECT_TIMEOUT_MS = 60_000;
const PROBE_LIST_TIMEOUT_MS = 60_000;

// 给 MCP SDK 的 promise 套超时（超时后由 finally 统一 close，避免子进程/连接泄漏）
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function probeMcpServer(id, opts = {}) {
  if (!opts.force) {
    const cached = probeCache.get(id);
    if (cached && Date.now() - cached.probed_at < STATUS_TTL_MS) {
      return cached;
    }
  }
  const server = getMcpServer(id);
  if (!server) throw Object.assign(new Error(`MCP 服务器不存在：${id}`), { status: 404 });
  if (!server.enabled) return { serverId: id, status: 'disabled', tools: [], error: '服务器已禁用', probed_at: Date.now() };

  let client = null;
  let transport = null;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

    if (server.transport === 'stdio') {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      transport = new StdioClientTransport({
        command: server.command,
        args: server.args || [],
        env: { ...process.env, ...server.env },
      });
    } else if (server.transport === 'sse') {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      transport = new SSEClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers || {} },
      });
    } else if (server.transport === 'streamable-http') {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers || {} },
      });
    } else {
      throw new Error(`不支持的传输类型：${server.transport}`);
    }

    client = new Client({ name: 'gate-service', version: '0.1.0' }, { capabilities: {} });
    await withTimeout(client.connect(transport), PROBE_CONNECT_TIMEOUT_MS, `连接超时（${PROBE_CONNECT_TIMEOUT_MS / 1000}s）：服务器未响应 initialize`);

    const toolsResult = await withTimeout(
      client.listTools(),
      opts.listTimeoutMs ?? PROBE_LIST_TIMEOUT_MS,
      `工具探测超时（${(opts.listTimeoutMs ?? PROBE_LIST_TIMEOUT_MS) / 1000}s）：stdio 类服务器首次冷启动较慢，可稍后重试`,
    );

    const tools = (toolsResult.tools || []).map(t => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || {},
    }));

    const result = { serverId: id, status: 'online', tools, probed_at: Date.now() };
    probeCache.set(id, result);
    return result;
  } catch (e) {
    const result = { serverId: id, status: 'error', tools: [], error: String(e.message || e), probed_at: Date.now() };
    probeCache.set(id, result);
    return result;
  } finally {
    if (client) { try { await client.close(); } catch {} }
  }
}

// 读缓存（不触发探测），供 mcp-market.js 的 serverHealth 使用
export function probeState(id) {
  return probeCache.get(id) || null;
}

export async function probeAllServers() {
  const servers = listMcpServers();
  const targets = servers.filter(s => s.enabled);
  if (!targets.length) return [];
  const results = await Promise.allSettled(targets.map(s => probeMcpServer(s.id)));
  // 注意用 targets 的下标回填：results 与 filter 后的数组一一对应，用 servers 会错位
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { serverId: targets[i].id, status: 'error', tools: [], error: String(r.reason), probed_at: Date.now() };
  });
}

export function invalidateProbe(id) {
  probeCache.delete(id);
}

// ── 获取草稿绑定的工具清单（供 forwardCreate 注入）────────────────

export async function getDraftBoundTools(bindings) {
  if (!bindings || !bindings.length) return [];
  const result = [];
  for (const b of bindings) {
    let probe;
    try {
      probe = await probeMcpServer(b.server_id);
    } catch {
      continue; // 服务器不存在则跳过
    }
    if (probe.status !== 'online') continue;
    const filtered = b.tool_names?.length
      ? probe.tools.filter(t => b.tool_names.includes(t.name))
      : probe.tools;
    result.push({
      server_id: b.server_id,
      server_name: b.server_name,
      tools: filtered,
    });
  }
  return result;
}
