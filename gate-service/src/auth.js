// auth.js — Bearer GATE_TOKEN 鉴权
const TOKEN = process.env.GATE_TOKEN || '';

export function checkAuth(req) {
  if (!TOKEN) return { ok: false, status: 503, msg: '服务端未配置 GATE_TOKEN，拒绝所有请求' };
  const h = req.headers['authorization'] || '';
  if (h === `Bearer ${TOKEN}`) return { ok: true };
  return { ok: false, status: 401, msg: '鉴权失败：需要 Authorization: Bearer <GATE_TOKEN>' };
}
