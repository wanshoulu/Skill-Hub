"""事件 Rail — 把 agent 过程事件转发到当前请求的 SSE 事件队列

after_tool_call 拦截两类工具调用并 emit 事件（经 ContextVar 注入的 emit 回调）：
- skill_tool        → {"type": "skill_load", "skill": <name>}   技能内容加载
- run_skill_script  → {"type": "tool", "tool": ..., "args": ...} 脚本执行
其余工具（内置 todo_* 等）不产生事件，避免噪声。
"""

import contextvars
import json
import logging
from typing import Any, Awaitable, Callable

from openjiuwen.harness.rails import DeepAgentRail

logger = logging.getLogger("skill-app-agent.rails")

EmitFn = Callable[[dict], Awaitable[None]]

# 当前请求的事件发射器；StreamingResponse 任务内 set，agent 子任务继承
current_emitter: contextvars.ContextVar[EmitFn | None] = contextvars.ContextVar(
    "skill_app_emitter", default=None
)


class AppEventRail(DeepAgentRail):
    """过程事件桥（参照 ai-native-bank SkillUsageRail 的 ctx 读取模式）。"""

    async def after_tool_call(self, ctx: Any) -> None:
        emit = current_emitter.get()
        if emit is None:
            return
        inputs = getattr(ctx, "inputs", None)
        if inputs is None:
            return
        tool_name = str(getattr(inputs, "tool_name", "") or "").rsplit(".", 1)[-1]
        args = getattr(inputs, "tool_args", None) or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (ValueError, TypeError):
                args = {}
        if not isinstance(args, dict):
            args = {}
        try:
            if tool_name == "skill_tool":
                skill = str(args.get("skill_name") or args.get("name") or "").strip()
                await emit({"type": "skill_load", "skill": skill or "(未知)"})
            elif tool_name == "run_skill_script":
                await emit({
                    "type": "tool",
                    "tool": "run_skill_script",
                    "skill": str(args.get("skill_name") or ""),
                    "script": str(args.get("script_path") or ""),
                    "status": "done",
                })
        except Exception:  # 事件发射失败绝不影响 agent 主链路
            logger.debug("emit rail event failed", exc_info=True)
