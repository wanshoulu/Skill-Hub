// usage.js — 触发调用埋点（本地 JSONL 存储 + 实时聚合）
// 三类事件来源（对应"触发调用指标"三层）：
// 1. agent_chat — 网关统一对话会话：/v1/agent/chat 建会话即计一次（服务端埋点）
// 2. mcp_tool  — MCP 工具调用：/v1/mcp/call 每次调用计一条，ok 标记成败（服务端埋点）
// 3. skill     — CLI/本地 Agent 的技能触发：平台感知不到，由 CLI 批量上报（POST /v1/usage）
// 存储：DATA_DIR/usage/usage-YYYYMM.jsonl 按月分文件 append-only；
// 聚合为实时计算（不走小时快照——数据在本地卷，不在 PG）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

const USAGE_DIR = 'usage';
const KINDS = ['skill', 'mcp_tool', 'agent_chat'];
const RETENTION_MONTHS = Number(process.env.STATS_USAGE_RETENTION_MONTHS || 6);
// 按 STATS_TIME_ZONE 切日（与 stats.js 保持一致）
const TIME_ZONE = process.env.STATS_TIME_ZONE || 'Asia/Shanghai';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

function monthTag(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function usageFile(ts) {
  return path.join(DATA_DIR, USAGE_DIR, `usage-${monthTag(ts)}.jsonl`);
}

function listMonthFiles() {
  const dir = path.join(DATA_DIR, USAGE_DIR);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((n) => {
      const m = n.match(/^usage-(\d{6})\.jsonl$/);
      return m ? { ym: m[1], rel: path.join(USAGE_DIR, n) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.ym.localeCompare(b.ym));
}

// 记录一条 usage 事件；任何失败静默（埋点绝不影响主链路）
export function recordUsage(evt) {
  try {
    const ts = Number.isFinite(evt?.ts) ? evt.ts : Date.now();
    if (!KINDS.includes(evt?.kind)) return false;
    const line = JSON.stringify({
      ts,
      kind: evt.kind,
      name: String(evt?.name || '').slice(0, 200),
      user: evt?.user == null ? null : String(evt.user).slice(0, 128),
      source: String(evt?.source || '').slice(0, 32) || 'platform',
      ok: typeof evt?.ok === 'boolean' ? evt.ok : null,
    });
    const file = usageFile(ts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// 聚合近 N 天事件：按 kind 分组 { total, failRate, uniqueUsers, daily, top }
export function aggUsage(days = 30) {
  const since = Date.now() - days * 24 * 3600 * 1000;
  const out = {};
  const users = {};
  const names = {};
  for (const k of KINDS) {
    out[k] = { total: 0, fail: 0, failRate: null, uniqueUsers: 0, daily: {}, top: [] };
    users[k] = new Set();
    names[k] = new Map();
  }
  for (const f of listMonthFiles()) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(DATA_DIR, f.rel), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!KINDS.includes(e.kind) || !Number.isFinite(e.ts) || e.ts < since) continue;
      const k = e.kind;
      const agg = out[k];
      agg.total += 1;
      if (e.ok === false) agg.fail += 1;
      if (e.user) users[k].add(String(e.user));
      const day = dayFmt.format(new Date(e.ts));
      agg.daily[day] = (agg.daily[day] || 0) + 1;
      if (e.name) {
        let ent = names[k].get(e.name);
        if (!ent) {
          ent = { c: 0, users: new Set() };
          names[k].set(e.name, ent);
        }
        ent.c += 1;
        if (e.user) ent.users.add(String(e.user));
      }
    }
  }
  for (const k of KINDS) {
    const agg = out[k];
    agg.failRate = agg.total > 0 ? Number((agg.fail / agg.total).toFixed(4)) : null;
    delete agg.fail;
    agg.uniqueUsers = users[k].size;
    agg.top = [...names[k].entries()]
      .map(([name, v]) => ({ name, count: v.c, users: v.users.size }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);
  }
  return out;
}

// 清理过期月份文件（collect 调度里顺带调用）
export function cleanOldUsage() {
  const cutoff = monthTag(Date.now() - RETENTION_MONTHS * 31 * 24 * 3600 * 1000);
  for (const f of listMonthFiles()) {
    if (f.ym < cutoff) {
      try {
        fs.unlinkSync(path.join(DATA_DIR, f.rel));
      } catch { /* 并发删除忽略 */ }
    }
  }
}
