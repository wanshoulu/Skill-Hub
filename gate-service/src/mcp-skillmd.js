// mcp-skillmd.js — 发布期把 MCP 绑定确定性写进 SKILL.md 的 mcp_tools 块
//
// 为什么要在打包时写而不是靠模型自觉：运行侧（skill-app-agent）只认 SKILL.md 里的
// mcp_tools 声明，模型忘写 / 写错 key 就直接导致技能装上了却没有工具。
// 这里以网关侧的绑定为准做一次机械写入（幂等、可重入、合并已有声明），
// 并且只做最小文本插入——不重排 frontmatter，不改动正文一个字。
const FM_RE = /^(﻿?\s*---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const BLOCK_RE = /^mcp_tools:[ \t]*\r?\n(?:[ \t]+\r?\n|[ \t]-[^\r\n]*\r?\n|[ \t]+[^\r\n]*\r?\n)*/m;

export function parseMcpTools(mdText) {
  const fm = mdText.match(FM_RE);
  const segs = [];
  if (fm) segs.push(fm[2]);
  for (const m of mdText.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) segs.push(m[1]);
  const out = [];
  for (const seg of segs) {
    let started = false;
    let cur = null;
    for (const raw of seg.split(/\r?\n/)) {
      const line = raw.replace(/\s+$/, '');
      if (/^mcp_tools\s*:/.test(line)) { started = true; cur = null; continue; }
      if (!started) continue;
      let m = line.match(/^\s*-\s*server\s*:\s*(.+?)\s*$/);
      if (m) {
        if (cur) out.push({ server: cur, tool: '' });
        cur = unquote(m[1]);
        continue;
      }
      m = line.match(/^\s+tool\s*:\s*(.+?)\s*$/);
      if (m) {
        if (cur) { out.push({ server: cur, tool: unquote(m[1]) }); cur = null; }
        continue;
      }
      if (line.trim() && !/^(\s|-)/.test(line)) started = false;
    }
    if (cur) out.push({ server: cur, tool: '' });
  }
  const seen = new Set();
  return out.filter((d) => {
    const k = `${d.server}\u0000${d.tool}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function unquote(s) {
  return String(s).trim().replace(/^["']|["']$/g, '');
}

function renderBlock(decls) {
  const lines = ['mcp_tools:'];
  for (const d of decls) {
    lines.push(`  - server: ${d.server}`);
    if (d.tool) lines.push(`    tool: ${d.tool}`);
  }
  return lines.join('\n');
}

// declarations: [{server, tool}]（tool 空串=整个服务器）
// 返回 { markdown, changed, added, kept }
export function injectMcpTools(markdown, declarations = []) {
  const decls = declarations.filter((d) => d && d.server);
  if (!decls.length) return { markdown, changed: false, added: [], kept: parseMcpTools(markdown) };

  const existing = parseMcpTools(markdown);
  const seen = new Set(existing.map((d) => `${d.server}\u0000${d.tool}`));
  const added = [];
  // 已声明整个服务器时，具体工具视为已覆盖；反之补充具体工具也保留
  for (const d of decls) {
    const k = `${d.server}\u0000${d.tool}`;
    if (seen.has(k)) continue;
    if (!d.tool && existing.some((e) => e.server === d.server && !e.tool)) continue;
    if (d.tool && existing.some((e) => e.server === d.server && !e.tool)) continue;
    seen.add(k);
    added.push(d);
  }
  if (!added.length) return { markdown, changed: false, added: [], kept: existing };

  const merged = [...existing, ...added].sort(
    (a, b) => a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool),
  );
  const block = renderBlock(merged);

  const fm = markdown.match(FM_RE);
  if (fm) {
    const body = fm[2];
    let next;
    if (BLOCK_RE.test(body)) {
      next = body.replace(BLOCK_RE, `${block}\n`).replace(/\n{3,}/g, '\n\n');
    } else {
      next = `${body.replace(/\s+$/, '')}\n${block}`;
    }
    next = next.replace(/[\s\r\n]+$/, '');
    return { markdown: `${fm[1]}${next}${fm[3]}${markdown.slice(fm[0].length)}`, changed: true, added, kept: merged };
  }

  // 无 frontmatter：追加围栏块（运行侧同样能解析）
  const tail = `\n\n## MCP 工具依赖\n\n\`\`\`yaml\n${block}\n\`\`\`\n`;
  return { markdown: `${markdown.replace(/\s+$/, '\n')}${tail}`, changed: true, added, kept: merged };
}
