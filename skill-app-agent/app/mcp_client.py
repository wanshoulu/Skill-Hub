"""MCP 运行时接入 — 技能声明的 mcp_tools → openjiuwen 原生 MCP 工具

链路：
1. 扫描已安装技能 SKILL.md 中的 mcp_tools 声明（frontmatter 或 ```yaml 围栏）：
   ```yaml
   mcp_tools:
     - server: <server_name>
       tool: <tool_name>
   ```
   tool 省略表示该 server 的全部工具；
2. 从 gate-service 注册表（GET /v1/mcp/servers）解析 server 连接配置，
   凭据（env/headers）集中在网关侧，技能包只引用 server 名，不携带连接信息；
3. 用 openjiuwen 原生客户端（Stdio/Sse/StreamableHttp）连接并 list_tools；
4. 包装为 MCPTool 注册给 DeepAgent，工具名改为 mcp_<server>_<tool> 避免冲突。

失败隔离：注册表不可达按"无 MCP"降级；单个服务器连接失败仅跳过该服务器，
不阻断 agent 构建（与 gate-service 构建侧"探测失败不阻断"同一原则）。
"""

import asyncio
import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

import httpx
from openjiuwen.core.foundation.tool.mcp.base import MCPTool, McpServerConfig
from openjiuwen.core.foundation.tool.mcp.client.sse_client import SseClient
from openjiuwen.core.foundation.tool.mcp.client.stdio_client import StdioClient
from openjiuwen.core.foundation.tool.mcp.client.streamable_http_client import (
    StreamableHttpClient,
)

from .config import gate_config, server_config, storage_config

logger = logging.getLogger("skill-app-agent.mcp")

CONNECT_TIMEOUT = 20.0
LIST_TIMEOUT = 15.0

_NAME_SANITIZE = re.compile(r"[^a-z0-9]+")
_MAX_TOOL_NAME = 60


@dataclass
class McpDeclaration:
    skill: str
    server: str
    tool: str  # 空串 = 该 server 的全部工具


@dataclass
class McpBuildResult:
    tools: list = field(default_factory=list)   # MCPTool 列表（接入 create_deep_agent 的 tools）
    status: dict = field(default_factory=dict)  # /v1/mcp/status 报告


# ── SKILL.md 解析 ────────────────────────────────────────────────

def _schema_segments(md_text: str) -> list[str]:
    """提取可能携带 mcp_tools 的文本段：frontmatter + 所有围栏代码块。"""
    segs: list[str] = []
    if md_text.lstrip().startswith("---"):
        m = re.match(r"^\s*---\s*\n(.*?)\n\s*---\s*(?:\n|$)", md_text, re.DOTALL)
        if m:
            segs.append(m.group(1))
    for m in re.finditer(r"```[^\n]*\n(.*?)```", md_text, re.DOTALL):
        segs.append(m.group(1))
    return segs


def parse_mcp_tools(md_text: str) -> list[tuple[str, str]]:
    """从 SKILL.md 文本解析 (server, tool) 声明；tool 为空串表示全部工具。"""
    out: list[tuple[str, str]] = []
    for seg in _schema_segments(md_text):
        started = False
        cur_server: str | None = None
        for raw in seg.splitlines():
            line = raw.rstrip()
            if re.match(r"^mcp_tools\s*:", line):
                started = True
                cur_server = None
                continue
            if not started:
                continue
            m = re.match(r"^\s*-\s*server\s*:\s*(.+?)\s*$", line)
            if m:
                if cur_server:
                    out.append((cur_server, ""))
                cur_server = m.group(1).strip().strip("\"'")
                continue
            m = re.match(r"^\s+tool\s*:\s*(.+?)\s*$", line)
            if m:
                if cur_server:
                    out.append((cur_server, m.group(1).strip().strip("\"'")))
                    cur_server = None
                continue
            # 非空且非列表续行的顶层行 → mcp_tools 块结束
            if line.strip() and not line.startswith((" ", "\t", "-")):
                started = False
        if cur_server:
            out.append((cur_server, ""))
    seen: set[tuple[str, str]] = set()
    uniq: list[tuple[str, str]] = []
    for pair in out:
        if pair not in seen:
            seen.add(pair)
            uniq.append(pair)
    return uniq


def collect_declarations(skills_root: Path) -> list[McpDeclaration]:
    """扫描全部已安装技能的 mcp_tools 声明。"""
    out: list[McpDeclaration] = []
    if not skills_root.is_dir():
        return out
    for md in sorted(skills_root.glob("*/SKILL.md")):
        try:
            text = md.read_text("utf8", errors="replace")
        except OSError:
            continue
        for server, tool in parse_mcp_tools(text):
            out.append(McpDeclaration(skill=md.parent.name, server=server, tool=tool))
    return out


# ── 注册表（gate-service）────────────────────────────────────────

async def fetch_registry() -> dict[str, dict]:
    """gate-service MCP 注册表，按 name 索引；失败返回空（降级为无 MCP）。"""
    if not gate_config.base_url:
        return {}
    headers = {}
    if server_config.gate_token:
        headers["Authorization"] = f"Bearer {server_config.gate_token}"
    try:
        async with httpx.AsyncClient(timeout=gate_config.timeout) as cli:
            r = await cli.get(f"{gate_config.base_url}/v1/mcp/servers", headers=headers)
            r.raise_for_status()
            payload = r.json()
        data = payload.get("data") if isinstance(payload, dict) else payload
        servers = data if isinstance(data, list) else []
        return {
            s["name"]: s
            for s in servers
            if isinstance(s, dict) and s.get("name")
        }
    except Exception as e:  # noqa: BLE001
        logger.warning("MCP 注册表拉取失败（按无 MCP 处理）: %s", e)
        return {}


# ── 原生客户端构建 ───────────────────────────────────────────────

def _build_client(cfg: dict):
    """按注册表条目构造 openjiuwen 原生 MCP 客户端（未连接）。"""
    transport = (cfg.get("transport") or "stdio").lower()
    base = dict(
        server_name=cfg["name"],
        server_path=cfg.get("url") or cfg.get("command") or "stdio",
        client_type=transport,
        params={},
        auth_headers=cfg.get("headers") or {},
    )
    if transport == "stdio":
        base["params"] = {
            "command": cfg.get("command"),
            "args": cfg.get("args") or [],
            "env": cfg.get("env") or {},
        }
        return StdioClient(McpServerConfig(**base))
    if transport == "sse":
        return SseClient(McpServerConfig(**base))
    if transport == "streamable-http":
        return StreamableHttpClient(McpServerConfig(**base))
    raise ValueError(f"不支持的 MCP 传输类型: {transport}")


def _tool_alias(server: str, tool: str) -> str:
    raw = f"mcp_{_NAME_SANITIZE.sub('_', server.lower())}_{_NAME_SANITIZE.sub('_', tool.lower())}"
    raw = raw.strip("_")[:_MAX_TOOL_NAME]
    return raw


class _NameMappedClient:
    """把 LLM 可见的别名还原为服务器原始工具名。

    openjiuwen 的 MCPTool.invoke 直接拿 card.name 当 call_tool 的 tool_name
    （见 core/foundation/tool/mcp/base.py），所以改名注册必须配合名称还原，
    否则服务器只会回 "Unknown tool: <alias>"。其余方法（connect/list_tools/
    close 等）原样委托真实客户端。
    """

    def __init__(self, client, real_by_alias: dict):
        self._client = client
        self._real_by_alias = real_by_alias

    async def call_tool(self, tool_name: str, arguments: dict, **kwargs):
        real = self._real_by_alias.get(tool_name, tool_name)
        return await self._client.call_tool(real, arguments, **kwargs)

    def __getattr__(self, item):
        return getattr(self._client, item)


# ── 构建入口（agent_factory 每次 rebuild 调用）────────────────────

# 已连接客户端按"代"管理：保留当前与上一代，更早的关闭（与 stale workspace
# 清理同一取舍——跨指纹重建时旧指纹的在途对话本就不保证存活）
_generations: list[list] = []
_last_status: dict = {}


async def _close_clients(clients: list) -> None:
    for c in clients:
        try:
            await c.close()
        except Exception:  # noqa: BLE001
            pass


async def build_mcp_tools() -> McpBuildResult:
    """扫描声明 → 解析注册表 → 连接 → 产出 MCPTool 列表与状态报告。"""
    global _last_status
    skills_root = Path(storage_config.skills_root)
    declarations = collect_declarations(skills_root)

    status: dict = {
        "declarations": [asdict(d) for d in declarations],
        "registry": None,
        "servers": [],
        "tools": [],
    }
    if not declarations:
        _last_status = status
        return McpBuildResult([], status)

    registry = await fetch_registry()
    status["registry"] = "ok" if registry else "unavailable"

    # server → 需要的工具集合（空串 = 全部）
    wanted: dict[str, set[str]] = {}
    for d in declarations:
        wanted.setdefault(d.server, set()).add(d.tool)

    tools: list = []
    seen_names: set[str] = set()
    clients: list = []

    for server_name, tool_names in wanted.items():
        entry: dict = {"server": server_name, "online": False, "status": None, "tools": []}
        cfg = registry.get(server_name)
        if not cfg:
            entry["status"] = "未在注册表中找到"
            status["servers"].append(entry)
            continue
        if cfg.get("enabled") is False:
            entry["status"] = "注册表中已禁用"
            status["servers"].append(entry)
            continue
        client = None
        try:
            client = _build_client(cfg)
            clients.append(client)
            connected = await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT)
            if not connected:
                raise RuntimeError("connect 返回 False")
            cards = await asyncio.wait_for(client.list_tools(), timeout=LIST_TIMEOUT)
            entry["online"] = True
            entry["status"] = "online"
            real_by_alias: dict[str, str] = {}
            proxy = _NameMappedClient(client, real_by_alias)
            for card in cards or []:
                raw_name = getattr(card, "name", "") or ""
                if tool_names and "" not in tool_names and raw_name not in tool_names:
                    continue
                alias = _tool_alias(server_name, raw_name)
                if alias in seen_names:
                    logger.warning("MCP 工具重名跳过: %s", alias)
                    continue
                seen_names.add(alias)
                real_by_alias[alias] = raw_name
                aliased = card.model_copy(update={"name": alias}) if hasattr(card, "model_copy") else card
                tools.append(MCPTool(proxy, aliased))
                entry["tools"].append(alias)
        except Exception as e:  # noqa: BLE001
            entry["status"] = f"连接失败: {str(e)[:160]}"
            logger.warning("MCP 服务器 %s 接入失败: %s", server_name, e)
        status["servers"].append(entry)

    status["tools"] = [t.card.name for t in tools]

    # 客户端分代管理：保留当前与上一代，关闭更早的
    _generations.append(clients)
    if len(_generations) > 2:
        stale = _generations.pop(0)
        await _close_clients(stale)

    _last_status = status
    return McpBuildResult(tools, status)


def last_status() -> dict:
    """/v1/mcp/status：实时声明扫描 + 最近一次构建报告。"""
    decls = collect_declarations(Path(storage_config.skills_root))
    return {
        "declarations": [asdict(d) for d in decls],
        "last_build": _last_status,
    }
