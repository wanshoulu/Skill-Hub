// server.js — gate-service HTTP 入口：REST 端点 + 统一对话 SSE + multipart 上传
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkAuth } from './auth.js';
import {
  ensureDirs, seedSkills, saveJson, readJson, draftDir, dirOf, readRun, listRuns, readEvidence,
} from './store.js';
import { packDraftDir } from './pack.js';
import { beginGate, executeGate, beginEval, executeEval, startEvolve, adoptJob, agentChat } from './orchestrator.js';
import { llm } from './llm.js';
import {
  listMcpServers, addMcpServer, updateMcpServer, removeMcpServer,
  probeMcpServer, probeAllServers, invalidateProbe,
} from './mcp.js';

const PORT = Number(process.env.PORT || 3002);
const VERSION = '0.1.0';
const MAX_UPLOAD = 50 * 1024 * 1024; // 50MB

const ok = (res, data, code = 0) => json(res, 200, { code, msg: 'ok', data });
const fail = (res, status, msg) => json(res, status, { code: status, msg, data: null });

function json(res, status, body) {
  const buf = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(buf) });
  res.end(buf);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// 最小 multipart/form-data 解析（file 二进制 + 文本字段）
function parseMultipart(buf, contentType) {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!m) throw Object.assign(new Error('multipart 缺少 boundary'), { status: 400 });
  const boundary = '--' + (m[1] || m[2]).trim();
  const fields = {};
  const files = {};
  const bBoundary = Buffer.from(boundary);
  let pos = buf.indexOf(bBoundary);
  while (pos >= 0) {
    const next = buf.indexOf(bBoundary, pos + bBoundary.length);
    if (next < 0) break;
    // part = \r\nheaders\r\n\r\ncontent\r\n
    let part = buf.subarray(pos + bBoundary.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd >= 0) {
      const head = part.subarray(0, headEnd).toString('utf8');
      const content = part.subarray(headEnd + 4);
      const nameM = head.match(/name="([^"]+)"/);
      const fileM = head.match(/filename="([^"]*)"/);
      if (nameM) {
        if (fileM) files[nameM[1]] = content;
        else fields[nameM[1]] = content.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

// ── 草稿存取 ─────────────────────────────────────────────────────

function newDraftId() {
  return `d${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

function safeDraftPath(base, rel) {
  const p = path.resolve(base, rel);
  if (!p.startsWith(path.resolve(base) + path.sep) && p !== path.resolve(base)) {
    throw Object.assign(new Error(`非法文件路径：${rel}`), { status: 400 });
  }
  return p;
}

async function writeDraftTo(dir, id, { name, markdown, files = [], dataset = null }) {
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8');
  for (const f of files) {
    const rel = String(f.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel === 'SKILL.md') continue;
    const abs = safeDraftPath(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(f.content ?? ''), 'utf8');
  }
  if (dataset) {
    fs.mkdirSync(path.join(dir, 'evals'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'evals', 'dataset.yaml'), dataset, 'utf8');
  }
  const meta = { id, name, created_at: Date.now(), updated_at: Date.now(), has_dataset: Boolean(dataset), mcp_bindings: [] };
  saveJson(path.relative(DATA_DIR, path.join(dir, 'meta.json')).replace(/\\/g, '/'), meta);
  return meta;
}

async function writeDraft(id, body) {
  const meta = await writeDraftTo(draftDir(id), id, body);
  // 恢复 created_at 和 mcp_bindings（writeDraftTo 不读旧 meta）
  const old = readJson(`drafts/${id}/meta.json`);
  if (old?.created_at && meta.created_at !== old.created_at) {
    meta.created_at = old.created_at;
  }
  if (old?.mcp_bindings) {
    meta.mcp_bindings = old.mcp_bindings;
  }
  saveJson(`drafts/${id}/meta.json`, meta);
  return meta;
}

function draftView(meta) {
  const dir = draftDir(meta.id);
  const files = [];
  const walk = (d, base) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'history' || entry.name === 'evals' || entry.name === 'meta.json') continue;
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
      else {
        const stat = fs.statSync(path.join(d, entry.name));
        files.push({ path: rel, size: stat.size });
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return { ...meta, files, dataset: fs.existsSync(path.join(dir, 'evals', 'dataset.yaml')) };
}

// ── 路由 ─────────────────────────────────────────────────────────

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method;

  // healthz 免鉴权（探测用）
  if (method === 'GET' && p === '/v1/healthz') {
    const l = llm.configured ? await llm.probe() : { ok: false, error: 'LLM 未配置', model: llm.model };
    return ok(res, { status: 'ok', version: VERSION, llm: l, uptime: process.uptime() });
  }

  const auth = checkAuth(req);
  if (!auth.ok) return fail(res, auth.status, auth.msg);

  // ── 统一对话入口（SSE）──
  if (method === 'POST' && p === '/v1/agent/chat') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch { return fail(res, 400, '请求体不是有效的 JSON'); }
    const sse = sseWriter(res);
    try {
      await agentChat(
        { message: String(body.message || ''), history: Array.isArray(body.history) ? body.history.slice(-20) : [], draft_id: body.draft_id || null, mode: body.mode || null },
        sse.send,
      );
    } catch (e) {
      sse.send('error', { error: String(e.message || e) });
    }
    sse.send('done', {});
    return sse.close();
  }

  // ── MCP 服务器注册表 ──────────────────────────────────────────────
  if (p === '/v1/mcp/servers' && method === 'GET') {
    return ok(res, listMcpServers());
  }
  if (p === '/v1/mcp/servers' && method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch { return fail(res, 400, '请求体不是有效的 JSON'); }
    if (!body.name) return fail(res, 400, '需要 name');
    if (body.transport === 'stdio' && !body.command) return fail(res, 400, 'stdio 传输需要 command');
    if ((body.transport === 'sse' || body.transport === 'streamable-http') && !body.url) return fail(res, 400, '该传输需要 url');
    return ok(res, addMcpServer(body));
  }
  const mcpServerM = p.match(/^\/v1\/mcp\/servers\/(mcp_[A-Za-z0-9_-]+)$/);
  if (mcpServerM) {
    const id = mcpServerM[1];
    if (method === 'PUT') {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch { return fail(res, 400, '请求体不是有效的 JSON'); }
      invalidateProbe(id);
      try { return ok(res, updateMcpServer(id, body)); }
      catch (e) { return fail(res, e.status || 500, String(e.message || e)); }
    }
    if (method === 'DELETE') {
      invalidateProbe(id);
      removeMcpServer(id);
      return ok(res, { deleted: id });
    }
  }
  // MCP 工具探测
  if (p === '/v1/mcp/tools' && method === 'GET') {
    return ok(res, await probeAllServers());
  }
  const mcpProbeM = p.match(/^\/v1\/mcp\/servers\/(mcp_[A-Za-z0-9_-]+)\/tools$/);
  if (mcpProbeM && method === 'GET') {
    try { return ok(res, await probeMcpServer(mcpProbeM[1])); }
    catch (e) { return fail(res, e.status || 500, String(e.message || e)); }
  }

  // ── 草稿 ──
  if (p === '/v1/drafts' && method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
    catch { return fail(res, 400, '请求体不是有效的 JSON'); }
    if (!body.name || !body.markdown) return fail(res, 400, '需要 name 与 markdown');
    const id = newDraftId();
    const meta = await writeDraft(id, body);
    return ok(res, draftView(meta));
  }
  if (p === '/v1/drafts' && method === 'GET') {
    const dir = dirOf('drafts');
    const list = fs.existsSync(dir)
      ? fs.readdirSync(dir).map((id) => readJson(`drafts/${id}/meta.json`)).filter(Boolean).map(draftView)
      : [];
    list.sort((a, b) => b.updated_at - a.updated_at);
    return ok(res, list);
  }

  const draftM = p.match(/^\/v1\/drafts\/(d[A-Za-z0-9_-]+)(\/zip)?$/);
  if (draftM) {
    const id = draftM[1];
    const meta = readJson(`drafts/${id}/meta.json`);
    if (!meta) return fail(res, 404, `草稿不存在：${id}`);

    if (method === 'GET' && !draftM[2]) return ok(res, { ...draftView(meta), markdown: readDraftMarkdown(id) });
    if (method === 'PUT' && !draftM[2]) {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch { return fail(res, 400, '请求体不是有效的 JSON'); }
      const dir = draftDir(id);
      // 先写入临时目录，成功后替换（防止 writeDraft 失败导致数据丢失）
      const tmpDir = path.join(path.dirname(dir), `${path.basename(dir)}.tmp.${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const backupBuf = fs.existsSync(path.join(dir, 'SKILL.md')) ? fs.readFileSync(path.join(dir, 'SKILL.md')) : null;
      try {
        writeDraftTo(tmpDir, id, body);
      } catch (e) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw e;
      }
      // 保留旧 history 目录
      const oldHist = path.join(dir, 'history');
      if (fs.existsSync(oldHist)) {
        fsp.cp(oldHist, path.join(tmpDir, 'history'), { recursive: true }).catch(() => {});
      }
      await fsp.rm(dir, { recursive: true, force: true });
      fs.renameSync(tmpDir, dir);
      if (backupBuf) {
        const histDir = path.join(dir, 'history');
        fs.mkdirSync(histDir, { recursive: true });
        fs.writeFileSync(path.join(histDir, `${Date.now()}-SKILL.md`), backupBuf);
      }
      // 保留旧 mcp_bindings（writeDraftTo 会重置为空数组）
      const oldMeta = readJson(`drafts/${id}/meta.json`);
      if (oldMeta?.mcp_bindings) {
        oldMeta.mcp_bindings = oldMeta.mcp_bindings;
        saveJson(`drafts/${id}/meta.json`, oldMeta);
      }
      // 如果请求体包含 mcp_bindings，更新它
      if (body.mcp_bindings !== undefined) {
        const meta = readJson(`drafts/${id}/meta.json`);
        if (meta) {
          meta.mcp_bindings = body.mcp_bindings;
          meta.updated_at = Date.now();
          saveJson(`drafts/${id}/meta.json`, meta);
        }
      }
      return ok(res, draftView(readJson(`drafts/${id}/meta.json`)));
    }
    if (method === 'DELETE' && !draftM[2]) {
      await fsp.rm(draftDir(id), { recursive: true, force: true });
      return ok(res, { deleted: id });
    }
    if (method === 'POST' && draftM[2]) {
      const zip = packDraftDir(draftDir(id));
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${meta.name}.zip"`,
        'Content-Length': zip.length,
      });
      return res.end(zip);
    }
  }

  // ── gate / eval（异步：立即返回 run_id，GET 轮询）──
  if ((p === '/v1/gate/run' || p === '/v1/eval/run') && method === 'POST') {
    const ct = req.headers['content-type'] || '';
    let source, level = 'release', ns = null;
    if (ct.includes('multipart/form-data')) {
      const buf = await readBody(req, MAX_UPLOAD);
      const { fields, files } = parseMultipart(buf, ct);
      if (!files.file) return fail(res, 400, 'multipart 需要 file 字段（skill zip）');
      if (files.file.length > MAX_UPLOAD) return fail(res, 413, 'zip 超过 50MB 上限');
      source = { type: 'zip', buf: files.file, datasetYaml: files.dataset?.toString('utf8') || null };
      level = fields.level || 'release';
      ns = fields.ns || null;
    } else {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch { return fail(res, 400, '请求体不是有效的 JSON'); }
      if (!body.draft_id) return fail(res, 400, '需要 draft_id 或 multipart 上传 zip');
      source = { type: 'draft', id: body.draft_id };
      level = body.level || 'release';
      ns = body.ns || null;
    }
    const kind = p.includes('gate') ? 'gate' : 'eval';
    const begin = kind === 'gate' ? beginGate : beginEval;
    const execute = kind === 'gate' ? executeGate : executeEval;
    const run = begin({ level, ns });
    // 后台执行；basic 秒级，runtime 可能数分钟，客户端轮询 GET /runs/:id
    execute(run, { source }).catch(() => {});
    return ok(res, { run_id: run.id, kind });
  }

  // ── runs 查询 ──
  const runM = p.match(/^\/v1\/(gate|eval|evolve)\/(runs|jobs)\/([A-Za-z0-9_-]+)$/);
  if (runM && method === 'GET') {
    const run = readRun(runM[1], runM[3]);
    if (!run) return fail(res, 404, `记录不存在：${runM[3]}`);
    return ok(res, run);
  }
  const runListM = p.match(/^\/v1\/(gate|eval|evolve)\/(runs|jobs)$/);
  if (runListM && method === 'GET') {
    return ok(res, listRuns(runListM[1]).slice(0, 100));
  }

  // ── evolve ──
  if (p === '/v1/evolve/run' && method === 'POST') {
    const ct = req.headers['content-type'] || '';
    let source, maxRounds = 1, ns = null, datasetYaml = null;
    if (ct.includes('multipart/form-data')) {
      const buf = await readBody(req, MAX_UPLOAD);
      const { fields, files } = parseMultipart(buf, ct);
      if (!files.file) return fail(res, 400, 'multipart 需要 file 字段（skill zip）');
      source = { type: 'zip', buf: files.file };
      datasetYaml = files.dataset?.toString('utf8') || null;
      maxRounds = Number(fields.max_rounds || 1);
      ns = fields.ns || null;
    } else {
      let body;
      try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); }
      catch { return fail(res, 400, '请求体不是有效的 JSON'); }
      if (!body.draft_id) return fail(res, 400, '需要 draft_id 或 multipart 上传 zip');
      source = { type: 'draft', id: body.draft_id };
      maxRounds = Number(body.max_rounds || 3);
      ns = body.ns || null;
    }
    const job = await startEvolve({ source, maxRounds, ns });
    return ok(res, { job_id: job.id, kind: 'evolve', status: job.status });
  }

  const adoptM = p.match(/^\/v1\/evolve\/jobs\/([A-Za-z0-9_-]+)\/adopt$/);
  if (adoptM && method === 'POST') {
    try {
      const r = await adoptJob(adoptM[1]);
      return ok(res, { job_id: adoptM[1], backup: r.backup, gate_run_id: r.gate_run_id, gate_status: r.gate_status });
    } catch (e) {
      return fail(res, e.status || 400, String(e.message || e));
    }
  }

  // ── 证据 ──
  const evM = p.match(/^\/v1\/evidence\/([a-z0-9-]+)\/([a-z0-9-]+)\/([a-f0-9]{64})$/);
  if (evM && method === 'GET') {
    const ev = readEvidence(evM[2], evM[3]); // ns 段仅做路径合法性校验，证据按 name/digest 索引
    if (!ev) return ok(res, { released: false });
    return ok(res, ev);
  }

  return fail(res, 404, `未知路由 ${method} ${p}`);
}

function readDraftMarkdown(id) {
  const p = path.join(draftDir(id), 'SKILL.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function sseWriter(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let last = Date.now();
  let closed = false;
  const hb = setInterval(() => {
    if (!closed && Date.now() - last > 15_000) send('hb', { ts: Date.now() });
  }, 5_000);
  res.on('close', () => { closed = true; clearInterval(hb); });
  function send(event, data) {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    last = Date.now();
  }
  function close() {
    closed = true;
    clearInterval(hb);
    res.end();
  }
  return { send, close };
}

// ── 启动 ─────────────────────────────────────────────────────────

await ensureDirs();
const seed = await seedSkills().catch((e) => ({ seeded: [], error: String(e.message) }));
if (seed.seeded?.length) console.log('[gate] seed 技能：', seed.seeded.join(', '));
if (llm.configured) llm.probe().then((r) => console.log('[gate] LLM 探测:', r.ok ? `ok ${r.latency_ms}ms` : `fail ${r.error}`));

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('[gate]', e);
    if (!res.headersSent) fail(res, e.status || 500, String(e.message || e));
    else res.end();
  });
});
server.listen(PORT, () => console.log(`[gate] gate-service listening on :${PORT} (data=${process.env.DATA_DIR || '/data'})`));
