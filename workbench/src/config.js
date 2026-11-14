import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 配置解析顺序：CLI 参数 > 环境变量 > ~/.skw/config.json
export function getConfig(overrides = {}) {
  let file = {};
  const cfgPath = path.join(os.homedir(), '.skw', 'config.json');
  try {
    // 去 UTF-8 BOM：Windows 下用 PowerShell 写的文件常带 BOM，不去掉 JSON.parse 会挂
    const raw = fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '');
    file = JSON.parse(raw);
  } catch (e) {
    // 没有配置文件就只靠环境变量/参数；但文件存在却解析不了要提醒，否则 401 排查很痛苦
    if (e.code !== 'ENOENT') {
      console.warn(`⚠ ${cfgPath} 解析失败（${e.message}），已忽略配置文件`);
    }
  }
  return {
    registry: overrides.registry || process.env.SKILLHUB_URL || file.registry,
    token: overrides.token || process.env.SKILLHUB_TOKEN || file.token,
    namespace:
      overrides.namespace || process.env.SKILLHUB_NAMESPACE || file.namespace,
    // 发布门禁（gate-service）：publish 强制走技能检查扫描，全过才上传注册中心
    gateUrl:
      overrides.gateUrl || process.env.SKW_GATE_URL || file.gateUrl,
    gateToken:
      overrides.gateToken || process.env.SKW_GATE_TOKEN || file.gateToken,
  };
}
