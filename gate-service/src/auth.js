// auth.js — Bearer GATE_TOKEN 鉴权
import crypto from 'node:crypto';

const TOKEN = process.env.GATE_TOKEN || '';

export function checkAuth(req) {
  if (!TOKEN) return { ok: false, status: 503, msg: '服务端未配置 GATE_TOKEN，拒绝所有请求' };
  const h = req.headers['authorization'] || '';
  const expected = `Bearer ${TOKEN}`;
  // 恒定时间比较，防止时序侧信道
  const a = Buffer.from(h);
  const b = Buffer.from(expected);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { ok: true };
  return { ok: false, status: 401, msg: '鉴权失败：需要 Authorization: Bearer <GATE_TOKEN>' };
}
