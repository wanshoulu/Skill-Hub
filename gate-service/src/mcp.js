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
  const server = {
    id: `mcp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: config.name,
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

export function updateMcpServer(id, patch) {
  const servers = listMcpServers();
  const idx = servers.findIndex(s => s.id === id);
  if (idx < 0) throw Object.assign(new Error(`MCP 服务器不存在：${id}`), { status: 404 });
  servers[idx] = { ...servers[idx], ...patch, id, updated_at: Date.now() };
  saveJson(REGISTRY_PATH, servers);
  return servers[idx];
}

export function removeMcpServer(id) {
  const servers = listMcpServers().filter(s => s.id !== id);
  saveJson(REGISTRY_PATH, servers);
}

// ── 工具探测（带缓存）────────────────────────────────────────────

const probeCache = new Map(); // serverId → { status, tools, error, probed_at }

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
    await client.connect(transport);

    const timeout = setTimeout(() => { try { client.close(); } catch {} }, opts.listTimeoutMs ?? 15_000);
    const toolsResult = await client.listTools();
    clearTimeout(timeout);

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
  if (!servers.length) return [];
  const results = await Promise.allSettled(
    servers.filter(s => s.enabled).map(s => probeMcpServer(s.id))
  );
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return { serverId: servers[i].id, status: 'error', tools: [], error: String(r.reason), probed_at: Date.now() };
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
