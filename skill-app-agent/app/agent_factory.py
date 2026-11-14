"""Agent 工厂 — 技能应用试运行 DeepAgent（openjiuwen create_deep_agent）

skills=[SKILLS_DIR]：安装到技能库的技能自动注册给 agent（skill_tool 按需加载）；
按技能目录树指纹缓存 agent 实例，install/uninstall 后指纹变化触发重建。
"""

import asyncio
import hashlib
import logging
import shutil
from pathlib import Path

from openjiuwen.core.foundation.llm import Model, ModelClientConfig, ModelRequestConfig
from openjiuwen.core.runner.runner import Runner
from openjiuwen.core.single_agent import AgentCard
from openjiuwen.core.sys_operation import LocalWorkConfig, OperationMode, SysOperationCard
from openjiuwen.harness import Workspace, create_deep_agent

from .config import llm_config, server_config, storage_config
from .rails import AppEventRail
from .tools import APP_TOOLS

logger = logging.getLogger("skill-app-agent.factory")

_SYSTEM_PROMPT = """【硬性约束】全程使用简体中文回复；回复的第一个字符必须是中文，绝不允许以英文单词或英文句子开头。

你是「技能应用试运行」助手，让用户真实体验与验证已安装到你的技能。已安装技能位于只读技能库，通过内置 skill_tool 加载技能内容（含 SKILL.md 使用说明）。

工作方式：
1. 收到领域问题时，先判断是否有已安装技能覆盖：有则走技能流程 —— 用 skill_tool 读取对应技能的说明，再按说明执行；
2. 技能带可执行脚本时，必须用 run_skill_script 工具真实执行（skill_name=技能目录名，script_path=技能内相对路径，args=命令行参数列表），不要凭记忆编造脚本输出，也不要自己重写脚本替代技能逻辑；
3. 脚本可能联网失败或超时：如实报告错误信息，绝不编造数据；
4. 没有可用技能或技能不覆盖当前问题时，直接用自身知识回答，并明确告知用户「本次未使用技能」；
5. 回答末尾简要说明：调用了什么技能与脚本、执行结果如何（关键数据保留）。
"""


def _patch_framework_fs_lock() -> None:
    """修复 openjiuwen 0.1.17.post1 与新版 filelock 的锁归属冲突。

    filelock 的 AsyncReadWriteLock 按 asyncio task 记录持有者，而框架的
    HybridAsyncReadWriteLock 在 asyncio.create_task 子任务里 acquire、在当前
    协程里 release —— 归属不匹配导致每次写文件报 "Cannot release a lock ...
    not held by this task"，锁永不释放，同路径第二次写永久挂起。
    改为在当前协程内直接 await acquire/release，轮询重试语义不变。
    """
    from filelock import Timeout as FileLockTimeout

    from openjiuwen.core.sys_operation.local._async_read_write_lock import (
        HybridAsyncReadWriteLock,
    )

    async def _acquire_file(self, mode, deadline):
        acquire = self._file.acquire_read if mode == "read" else self._file.acquire_write
        while True:
            try:
                await acquire(timeout=0, blocking=False)
                return
            except FileLockTimeout:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise self._timeout() from None
                await asyncio.sleep(min(self._poll_interval, remaining))

    async def _release_file(self):
        await self._file.release()

    HybridAsyncReadWriteLock._acquire_file = _acquire_file
    HybridAsyncReadWriteLock._release_file = _release_file


_patch_framework_fs_lock()


def _skills_fingerprint() -> str:
    """技能目录树指纹：(相对路径, size, mtime_ns) 排序后 sha256。

    忽略隐藏文件（如框架误写入的 .workspace 标记），防止框架内部写入
    引起指纹漂移触发无谓的 agent 重建。
    """
    root = Path(storage_config.skills_root)
    h = hashlib.sha256()
    if not root.is_dir():
        return h.hexdigest()
    for p in sorted(root.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            st = p.stat()
            h.update(f"{p.relative_to(root).as_posix()}|{st.st_size}|{st.st_mtime_ns}\n".encode())
    return h.hexdigest()


async def _ensure_skills_copy(ws_dir: Path, skills_root: Path) -> None:
    """把技能库复制为 workspace 的 skills 节点（per-fp 独立副本）。

    SkillUseRail 扫描 workspace.get_node_path("skills")，而非 create_deep_agent 的
    skills 参数——必须有 skills 节点技能内容才对 rail 可见。
    用复制而非软链：Workspace 初始化会向所有节点目录写 .workspace 标记，
    软链会把标记真实写进 /data/skills，污染技能树并使指纹漂移；副本落在
    本指纹的 workspace 内，隔离了框架对技能节点的任何写入。
    """
    node = ws_dir / "skills"
    try:
        if node.is_symlink() or node.is_file():
            node.unlink()
        await asyncio.to_thread(shutil.copytree, skills_root, node, dirs_exist_ok=True)
    except OSError as e:
        logger.warning("skills 副本复制失败（%s）: %s", node, e)


def _ensure_sysop_sandbox(card, skills_root: Path) -> None:
    """预注册同 id 的 sys_operation，把全局技能库加入 fs 沙箱白名单。

    create_deep_agent 自动创建的 sys_operation 不带 sandbox_root，fallback 沙箱
    只有 workspace——skill_tool 按全局库路径 /data/skills 加载技能会被
    "outside sandbox" 拒绝读。按框架的 get-or-create 语义先注册（严格 add 会报
    重复），工厂即复用；sandbox_root 用静态超集（workspace 父目录 + 技能库），
    跨指纹重建无需变更。读写粒度仍由 file_guard 控制（技能库只读）。
    """
    sysop_id = f"{card.name}_{card.id}"
    try:
        if Runner.resource_mgr.get_sys_operation(sysop_id) is not None:
            return
        Runner.resource_mgr.add_sys_operation(
            SysOperationCard(
                id=sysop_id,
                mode=OperationMode.LOCAL,
                work_config=LocalWorkConfig(
                    shell_allowlist=None,
                    restrict_to_sandbox=True,
                    sandbox_root=[str(storage_config.workspace_root), str(skills_root)],
                ),
            )
        )
        logger.info("sys_operation sandbox registered: %s -> [%s, %s]", sysop_id,
                    storage_config.workspace_root, skills_root)
    except Exception as e:  # noqa: BLE001
        logger.warning("sys_operation 预注册失败（沙箱可能拒绝技能库读取）: %s", e)


class AgentManager:
    """按指纹缓存 agent 实例。"""

    def __init__(self) -> None:
        self._agent = None
        self._fingerprint: str | None = None
        self._ws_dir: Path | None = None
        self._rail = AppEventRail()
        self._card = None

    @property
    def card(self):
        """当前 AgentCard（get_agent() 后可用），供 Session 绑定。"""
        return self._card

    @property
    def workspace_dir(self) -> Path:
        """当前 agent 的 workspace 目录（get_agent() 后有效）。"""
        return self._ws_dir if self._ws_dir is not None else Path(storage_config.workspace_root)

    def invalidate(self) -> None:
        # 不删旧 workspace：在途对话可能仍在使用，留给下次重建时清理
        self._agent = None
        self._fingerprint = None

    async def get_agent(self):
        fp = _skills_fingerprint()
        if self._agent is not None and fp == self._fingerprint:
            return self._agent
        logger.info("rebuilding deep agent (skills fingerprint=%s)", fp[:16])
        # 每个指纹独立 workspace 子目录：openjiuwen 的 memory/workspace 文件锁
        # 会被已初始化 agent 持久持有，路径重叠会导致新 agent 初始化死锁
        ws_dir = Path(storage_config.workspace_root) / f"run-{fp[:8]}"
        self._agent = await self._build(ws_dir)
        old_ws = self._ws_dir
        self._ws_dir = ws_dir
        self._fingerprint = fp
        if old_ws is not None and old_ws != ws_dir:
            self._cleanup_stale_workspaces({ws_dir.name, old_ws.name})
        return self._agent

    def _cleanup_stale_workspaces(self, keep_names: set[str]) -> None:
        """best-effort 清理更早指纹遗留的 workspace（保留当前与上一个，避免打断在途对话）。"""
        try:
            for child in Path(storage_config.workspace_root).glob("run-*"):
                if child.name in keep_names:
                    continue
                shutil.rmtree(child, ignore_errors=True)
                logger.info("cleaned stale workspace: %s", child.name)
        except Exception as e:  # noqa: BLE001
            logger.warning("workspace 清理失败: %s", e)

    async def _build(self, ws_dir: Path):
        model = Model(
            ModelClientConfig(
                client_provider="openai",
                api_key=llm_config.api_key,
                api_base=llm_config.api_base,
                timeout=llm_config.request_timeout,
                stream_first_chunk_timeout=llm_config.stream_first_chunk_timeout,
                stream_idle_timeout=llm_config.stream_idle_timeout,
                max_retries=llm_config.max_retries,
            ),
            ModelRequestConfig(
                model=llm_config.model,
                temperature=llm_config.temperature,
                max_tokens=llm_config.max_tokens,
            ),
        )
        card = AgentCard(
            id="skill-app-agent",
            name="技能应用试运行助手",
            description="安装技能库技能并真实试运行 agent+skill 的体验环境",
        )
        self._card = card
        skills_root = Path(storage_config.skills_root)
        skills_root.mkdir(parents=True, exist_ok=True)
        ws_dir.mkdir(parents=True, exist_ok=True)
        workspace = Workspace(root_path=str(ws_dir), language="cn")
        await _ensure_skills_copy(ws_dir, skills_root)
        _ensure_sysop_sandbox(card, skills_root)

        # 自定义工具 + 内置 skill_tool（技能加载，不放行会被 tiered_policy 拒绝）
        # + openjiuwen 任务规划内置工具
        tool_permissions = {t.card.name: "allow" for t in APP_TOOLS}
        tool_permissions["skill_tool"] = "allow"
        for todo_tool in ("todo_create", "todo_get", "todo_list", "todo_modify"):
            tool_permissions[todo_tool] = "allow"
        permissions = {
            "enabled": True,
            "schema": "tiered_policy",
            "defaults": {"*": "deny"},
            "tools": tool_permissions,
            "file_guard": {
                "enabled": True,
                "defaults": {"read": "deny", "write": "deny", "exec": "deny"},
                "paths": [
                    {  # 当前指纹的 workspace：可读写，不可执行
                        "path": str(ws_dir),
                        "read": "allow", "write": "allow", "exec": "deny",
                        "match": "prefix",
                    },
                    {  # 技能库：只读
                        "path": str(skills_root),
                        "read": "allow", "write": "deny", "exec": "deny",
                        "match": "prefix",
                    },
                ],
            },
        }

        return create_deep_agent(
            model=model,
            card=card,
            workspace=workspace,
            system_prompt=_SYSTEM_PROMPT,
            tools=APP_TOOLS,
            skills=[str(skills_root)],
            rails=[self._rail],
            enable_task_loop=True,
            enable_task_planning=True,
            max_iterations=30,
            permissions=permissions,
            parallel_tool_calls=False,
            restrict_to_work_dir=True,
            enable_security_rail=True,
            language="cn",
        )


manager = AgentManager()
