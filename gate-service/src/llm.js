// llm.js — OpenAI 兼容客户端（qwen 直连）+ 启动探测
// env: LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（部署探测后写入 .env）

const BASE = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'qwen3.7-flash';

let lastProbe = null; // { ok, model, latency_ms, error, checked_at }
let probing = null;

async function chat(messages, opts = {}) {
  if (!BASE || !KEY) {
    const err = new Error('LLM 未配置：需要 LLM_BASE_URL / LLM_API_KEY 环境变量');
    err.code = 'LLM_NOT_CONFIGURED';
    throw err;
  }
  const body = {
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 2000,
  };
  if (opts.json) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new Error(`LLM HTTP ${res.status}（${MODEL}）：${text}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(`LLM 返回空内容：${JSON.stringify(data).slice(0, 300)}`);
    }
    return content;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`LLM 请求超时（${(opts.timeoutMs ?? 60_000) / 1000}s，端点 ${BASE}）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// JSON 模式调用：剥 code fence + 解析，失败重试 1 次（judge 格式漂移兜底）
async function chatJson(messages, opts = {}) {
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const text = await chat(messages, { ...opts, json: true });
      const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
      return JSON.parse(cleaned);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`LLM JSON 输出解析失败（重试后仍失败）：${lastErr?.message}`);
}

// 探测（healthz 用，缓存 60s）
async function probe(force = false) {
  if (!force && lastProbe && Date.now() - lastProbe.checked_at < 60_000) return lastProbe;
  if (probing) return probing;
  probing = (async () => {
    const t0 = Date.now();
    let result;
    try {
      await chat([{ role: 'user', content: 'ping' }], { maxTokens: 8, temperature: 0, timeoutMs: 10_000 });
      result = { ok: true, model: MODEL, latency_ms: Date.now() - t0, error: null };
    } catch (e) {
      result = { ok: false, model: MODEL, latency_ms: Date.now() - t0, error: String(e.message || e) };
    }
    result.checked_at = Date.now();
    lastProbe = result;
    probing = null;
    return result;
  })();
  return probing;
}

export const llm = { chat, chatJson, probe, get model() { return MODEL; }, get configured() { return Boolean(BASE && KEY); } };
