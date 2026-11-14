"""注册中心客户端 — search / resolve / download（匿名公开技能）

API 契约（参照 skillhub-src/plugins/dsh/src/host/registry-adapter.ts）：
- GET /api/cli/v1/skills/search?q=&limit=20
    data: { items: [{namespace, slug, latestVersion, summary}], total, limit }
- GET /api/cli/v1/skills/{ns}/{slug}/resolve?version=
    data: { namespace, slug, version, versionId, fingerprint, downloadUrl }
- downloadUrl 直接 GET 返回 zip 字节

响应可能是 {code,msg,data} 信封或裸 JSON，两者兼容。
"""

import logging
from typing import Any

import httpx

from .config import registry_config

logger = logging.getLogger("skill-app-agent.registry")

_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def _unwrap(payload: Any) -> Any:
    """兼容 {code,msg,data} 信封与裸 JSON。"""
    if isinstance(payload, dict) and "data" in payload and "code" in payload:
        return payload["data"]
    return payload


def _auth_headers() -> dict[str, str]:
    if registry_config.token:
        return {"Authorization": f"Bearer {registry_config.token}"}
    return {}


async def search_skills(query: str = "", limit: int = 20) -> dict[str, Any]:
    """搜索注册中心技能。返回 {items: [{namespace, slug, latestVersion, summary}], total}"""
    params = {"q": query, "limit": min(max(int(limit), 1), 20)}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(
            f"{registry_config.base_url}/api/cli/v1/skills/search",
            params=params, headers=_auth_headers(),
        )
        resp.raise_for_status()
        data = _unwrap(resp.json())
    items = []
    for item in data.get("items", []):
        items.append({
            "namespace": str(item.get("namespace", "")),
            "slug": str(item.get("slug", "")),
            "latestVersion": str(item.get("latestVersion", "")),
            "summary": item.get("summary"),
        })
    return {"items": items, "total": int(data.get("total", len(items)))}


async def resolve_skill(namespace: str, slug: str, version: str | None = None) -> dict[str, Any]:
    """解析技能最新（或指定）版本 → {version, fingerprint, downloadUrl}"""
    params = {"version": version} if version else {}
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.get(
            f"{registry_config.base_url}/api/cli/v1/skills/{namespace}/{slug}/resolve",
            params=params, headers=_auth_headers(),
        )
        resp.raise_for_status()
        data = _unwrap(resp.json())
    if not data or not data.get("downloadUrl"):
        raise ValueError(f"registry resolve 未返回 downloadUrl: namespace={namespace} slug={slug}")
    return {
        "namespace": str(data.get("namespace", namespace)),
        "slug": str(data.get("slug", slug)),
        "version": str(data.get("version", "")),
        "fingerprint": str(data.get("fingerprint", "")),
        "downloadUrl": str(data["downloadUrl"]),
    }


async def download_skill_zip(download_url: str) -> bytes:
    """下载技能 zip 包。downloadUrl 兼容绝对 URL 与站内相对路径。"""
    url = download_url
    if url.startswith("/"):
        url = f"{registry_config.base_url}{url}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0), follow_redirects=True) as client:
        resp = await client.get(url, headers=_auth_headers())
        resp.raise_for_status()
        return resp.content
