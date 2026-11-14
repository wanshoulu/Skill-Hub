import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getConfig } from './config.js';
import { pack } from './pack.js';
import { gateRunRelease, printGateReport } from './gate.js';

const HTTP_TIMEOUT_MS = 30_000;

// 错误响应体可能是 HTML 大页面，截断防刷屏
function truncate(text, max = 500) {
  const s = String(text ?? '').trim();
  return s.length <= max ? s : `${s.slice(0, max)}…（共 ${s.length} 字符）`;
}

// 401/403 给人话提示
function authHint(res) {
  if (res.status === 401) return '（token 无效或过期：去 Web UI 重新生成，或检查 ~/.skw/config.json）';
  if (res.status === 403) return '（token 有效但无权限：检查命名空间是否正确，以及 token 权限范围）';
  return '';
}

// 统一解包 {code,msg,data} 信封（官方 /api/v1 契约）
function unwrap(payload) {
  if (payload && typeof payload === 'object' && 'code' in payload && 'data' in payload) {
    if (payload.code !== 0 && payload.code !== null) {
      throw new Error(`SkillHub API 错误 ${payload.code}: ${payload.msg ?? ''}`);
    }
    return payload.data;
  }
  return payload;
}

async function apiGet(cfg, pathname) {
  const res = await fetch(`${cfg.registry}${pathname}`, {
    headers: { Authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${pathname}: ${truncate(await res.text())} ${authHint(res)}`);
  }
  return unwrap(await res.json());
}

export async function publish(dir, opts = {}) {
  const cfg = getConfig(opts);
  if (!cfg.registry) {
    throw new Error('缺少 registry：用 --registry、环境变量 SKILLHUB_URL，或写进 ~/.skw/config.json');
  }
  if (!cfg.token) {
    throw new Error('缺少 token：用 --token、环境变量 SKILLHUB_TOKEN，或写进 ~/.skw/config.json');
  }
  if (!cfg.namespace) {
    throw new Error('缺少 namespace：用 --namespace、环境变量 SKILLHUB_NAMESPACE，或写进 ~/.skw/config.json');
  }
  cfg.registry = cfg.registry.replace(/\/+$/, '');

  console.log(`→ 打包 ${dir}`);
  const zipPath = pack(dir);
  const zipName = path.basename(zipPath);

  // 发布门禁（强拦截，无逃生门）：release 级检查全过 + 证据 digest 绑定才放行
  console.log(`→ 发布门禁（release 级）：${zipName}`);
  const { run, digest } = await gateRunRelease({ zipPath, skillDir: dir });
  printGateReport(run);
  if (run.status !== 'passed') {
    throw new Error('发布被门禁拦截：至少一项技能检查未通过（带 evals/dataset.yaml 可通过测评项）');
  }

  console.log(`→ 上传 ${zipName} 到命名空间 ${cfg.namespace}（${cfg.registry}）`);

  // multipart：file + visibility；namespace 在路径里，X-Request-Id 保证幂等
  const form = new FormData();
  form.append(
    'file',
    new Blob([fs.readFileSync(zipPath)], { type: 'application/zip' }),
    zipName
  );
  if (opts.visibility) form.append('visibility', opts.visibility);
  const res = await fetch(
    `${cfg.registry}/api/cli/v1/skills/${encodeURIComponent(cfg.namespace)}/publish`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'X-Request-Id': randomUUID(),
      },
      body: form,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${truncate(await res.text())} ${authHint(res)}`);
  }
  return unwrap(await res.json());
}

export async function whoami(opts = {}) {
  const cfg = getConfig(opts);
  if (!cfg.registry || !cfg.token) {
    throw new Error('需要 registry + token（参数、环境变量或 ~/.skw/config.json 任一即可）');
  }
  cfg.registry = cfg.registry.replace(/\/+$/, '');
  return apiGet(cfg, '/api/cli/v1/auth/whoami');
}

export async function publishCmd(dir, opts) {
  const data = await publish(dir, opts);
  console.log(`✓ 发布成功`);
  // 提取关键字段给一行摘要，完整响应照旧打 JSON
  const summary = [
    data?.name && `名称=${data.name}`,
    data?.version && `版本=${data.version}`,
    data?.visibility && `可见性=${data.visibility}`,
  ].filter(Boolean);
  if (summary.length) console.log(`  ${summary.join('  ')}`);
  console.log(JSON.stringify(data, null, 2));
}

export async function whoamiCmd(opts) {
  const data = await whoami(opts);
  const who = data?.userId || data?.username || data?.sub || data?.id;
  console.log(`✓ token 有效${who ? `，身份：${who}` : ''}`);
  console.log(JSON.stringify(data, null, 2));
}
