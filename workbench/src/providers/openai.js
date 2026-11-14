// OpenAI 兼容接口（含各家中转）：需要环境变量
//   OPENAI_API_KEY  必填
//   OPENAI_BASE_URL 可选，默认 https://api.openai.com/v1
//   OPENAI_MODEL    可选，默认 gpt-4o-mini
const LLM_TIMEOUT_MS = 120_000; // LLM 生成慢，超时放宽到 2 分钟

export async function openaiProvider({ system, input }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('openai provider 需要 OPENAI_API_KEY 环境变量');
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: input },
      ],
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = String(await res.text()).trim();
    throw new Error(`LLM HTTP ${res.status}: ${body.length > 500 ? body.slice(0, 500) + '…' : body}`);
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('LLM 返回的不是 JSON（检查 OPENAI_BASE_URL 是否指向 OpenAI 兼容接口）');
  }
  const content = json.choices?.[0]?.message?.content;
  if (content == null) {
    throw new Error(`LLM 响应缺少 choices[0].message.content：${JSON.stringify(json).slice(0, 300)}`);
  }
  return content;
}
