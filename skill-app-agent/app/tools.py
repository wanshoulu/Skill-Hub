"""自定义工具 — run_skill_script：执行已安装技能包内的脚本

技能脚本以子进程 python 执行（工作目录 = agent workspace），
60s 超时、输出截断，脚本路径 resolve 后必须仍位于对应技能目录内。
"""

import asyncio
import sys
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from openjiuwen.core.foundation.tool import tool

from .config import storage_config

MAX_OUTPUT_CHARS = 8000
SCRIPT_TIMEOUT = 60.0

# 脚本执行工作目录 = 当前 agent 指纹的 workspace（run-<fp8>）；chat 建立时由 main 设置
workspace_cwd: ContextVar[str] = ContextVar(
    "workspace_cwd", default=str(storage_config.workspace_root)
)


def _resolve_script(skill_name: str, script_path: str) -> Path:
    root = Path(storage_config.skills_root).resolve()
    skill_dir = (root / skill_name).resolve()
    if not str(skill_dir).startswith(str(root)) or skill_dir == root:
        raise ValueError(f"技能名不合法: {skill_name}")
    if not skill_dir.is_dir():
        raise FileNotFoundError(f"技能未安装: {skill_name}")
    script = (skill_dir / script_path).resolve()
    if not str(script).startswith(str(skill_dir)):
        raise ValueError(f"脚本路径越界，已拒绝: {script_path}")
    if not script.is_file():
        raise FileNotFoundError(f"脚本不存在: {skill_name}/{script_path}")
    return script


def _truncate(text: str) -> str:
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    return text[: MAX_OUTPUT_CHARS // 2] + f"\n...[截断 {len(text)} 字符]...\n" + text[-MAX_OUTPUT_CHARS // 2:]


@tool(
    name="run_skill_script",
    description=(
        "执行已安装技能包内的 Python 脚本。skill_name=技能目录名；"
        "script_path=技能内相对路径（如 scripts/get_stock.py）；"
        "args=命令行参数列表（可选）。这是运行技能能力（行情查询/数据处理等）的唯一入口。"
    ),
    input_params={
        "type": "object",
        "properties": {
            "skill_name": {"type": "string", "description": "技能目录名，如 stock-lookup"},
            "script_path": {"type": "string", "description": "技能内相对路径，如 scripts/get_stock.py"},
            "args": {
                "type": "array",
                "items": {"type": "string"},
                "description": "传给脚本的命令行参数（可选）",
            },
        },
        "required": ["skill_name", "script_path"],
    },
    auto_extract=False,
)
async def run_skill_script(
    skill_name: str, script_path: str, args: list[str] | None = None
) -> dict[str, Any]:
    script = _resolve_script(skill_name, script_path)
    workspace = Path(workspace_cwd.get())
    workspace.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, str(script), *[str(a) for a in (args or [])]]
    t0 = time.time()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(workspace),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={"PYTHONUNBUFFERED": "1", "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(workspace)},
        )
    except Exception as e:  # 启动失败
        return {"ok": False, "error": f"脚本启动失败: {e}"}
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=SCRIPT_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        return {
            "ok": False,
            "error": f"脚本执行超时（{int(SCRIPT_TIMEOUT)}秒），已终止",
            "durationMs": int((time.time() - t0) * 1000),
        }
    out = stdout.decode("utf-8", errors="replace")
    err = stderr.decode("utf-8", errors="replace")
    return {
        "ok": proc.returncode == 0,
        "exitCode": proc.returncode,
        "stdout": _truncate(out),
        "stderr": _truncate(err) if proc.returncode != 0 else err[-500:],
        "durationMs": int((time.time() - t0) * 1000),
    }


APP_TOOLS = [run_skill_script]
