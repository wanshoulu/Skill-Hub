"""技能安装器 — 注册中心 zip → SKILLS_DIR/<name>/，安全解压 + 卸载白名单"""

import asyncio
import io
import logging
import re
import shutil
import zipfile
from pathlib import Path

from . import registry_client
from .config import storage_config

logger = logging.getLogger("skill-app-agent.installer")

# 卸载/加载名白名单：小写字母数字开头，仅 [a-z0-9-_.]，防目录穿越
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

_INSTALL_TIMEOUT = 90.0


def skills_root() -> Path:
    return Path(storage_config.skills_root)


def _safe_entry_name(name: str) -> None:
    """拒绝绝对路径、盘符、..、反斜杠条目。"""
    if not name or name.startswith("/") or "\\" in name or ".." in Path(name).parts:
        raise ValueError(f"zip 条目不安全，已拒绝解压: {name}")
    if re.match(r"^[A-Za-z]:", name):
        raise ValueError(f"zip 条目不安全（盘符路径），已拒绝解压: {name}")


def _common_top_level(zf: zipfile.ZipFile) -> str | None:
    """所有文件条目是否共享同一顶层目录；是则返回该目录名。"""
    roots: set[str] = set()
    for info in zf.infolist():
        if info.is_dir():
            continue
        parts = Path(info.filename).parts
        if len(parts) > 1:
            roots.add(parts[0])
        else:
            return None  # 有根级散文件 → 无统一顶层
    return roots.pop() if len(roots) == 1 else None


def _extract_into(zf: zipfile.ZipFile, dest: Path) -> int:
    """解压到 dest，剥离统一顶层目录，返回解压文件数。"""
    dest_resolved = dest.resolve()
    strip = _common_top_level(zf)
    count = 0
    for info in zf.infolist():
        _safe_entry_name(info.filename)
        rel = Path(info.filename)
        if info.is_dir():
            continue
        if strip and len(rel.parts) > 1 and rel.parts[0] == strip:
            rel = Path(*rel.parts[1:])
        if not rel.parts:
            continue
        target = dest_resolved / rel
        target_resolved = target.resolve()
        if not str(target_resolved).startswith(str(dest_resolved)):
            raise ValueError(f"zip 条目越界，已拒绝: {info.filename}")
        target_resolved.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(info) as src, open(target_resolved, "wb") as out:
            shutil.copyfileobj(src, out)
        count += 1
    return count


def installed_skill_names() -> list[str]:
    root = skills_root()
    if not root.is_dir():
        return []
    return sorted(p.parent.name for p in root.glob("*/SKILL.md"))


def _frontmatter_field(md_text: str, field: str) -> str | None:
    m = re.search(rf"^{field}:\s*(.+?)\s*$", md_text, re.MULTILINE)
    return m.group(1).strip().strip("\"'") if m else None


def list_installed() -> list[dict]:
    """已安装技能详情：name / description / has_scripts / files 数。"""
    out = []
    root = skills_root()
    if not root.is_dir():
        return out
    for skill_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        md = skill_dir / "SKILL.md"
        if not md.is_file():
            continue
        try:
            text = md.read_text("utf8", errors="replace")[:4000]
        except OSError:
            text = ""
        scripts = skill_dir / "scripts"
        out.append({
            "name": skill_dir.name,
            "description": _frontmatter_field(text, "description"),
            "hasScripts": scripts.is_dir() and any(scripts.glob("*.py")),
            "installedAt": int(skill_dir.stat().st_mtime),
        })
    return out


_install_locks: dict[str, asyncio.Lock] = {}


async def install(namespace: str, slug: str, version: str | None = None) -> dict:
    """resolve → download → 安全解压到 SKILLS_DIR/<slug>/ → 重建指纹。"""
    if not _NAME_RE.match(slug):
        raise ValueError(f"slug 不合法: {slug}")
    lock = _install_locks.setdefault(slug, asyncio.Lock())
    async with lock:
        resolved = await registry_client.resolve_skill(namespace, slug, version)
        dest = skills_root() / slug
        if dest.exists():
            raise FileExistsError(f"技能已安装: {slug}")
        skills_root().mkdir(parents=True, exist_ok=True)
        content = await registry_client.download_skill_zip(resolved["downloadUrl"])
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            count = _extract_into(zf, dest)
        if not (dest / "SKILL.md").is_file():
            shutil.rmtree(dest, ignore_errors=True)
            raise ValueError(f"技能包缺少 SKILL.md: {slug}（共 {count} 个文件）")
        logger.info("installed skill %s/%s v%s fingerprint=%s files=%d",
                    namespace, slug, resolved["version"], resolved["fingerprint"][:16], count)
        return {
            "name": slug, "namespace": namespace, "version": resolved["version"],
            "fingerprint": resolved["fingerprint"], "files": count,
        }


def uninstall(name: str) -> None:
    if not _NAME_RE.match(name):
        raise ValueError(f"技能名不合法: {name}")
    dest = skills_root() / name
    if not dest.is_dir():
        raise FileNotFoundError(f"技能未安装: {name}")
    shutil.rmtree(dest)
    logger.info("uninstalled skill %s", name)
