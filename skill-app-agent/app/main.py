"""Skill 应用试运行 Agent — FastAPI 入口（SSE 对话 + 技能安装管理）

API 契约（/v1，Bearer GATE_TOKEN，healthz 免鉴权）：
- GET  /v1/healthz            {status, registry, llm, installed}
- GET  /v1/agent              agent 档案 + 已安装技能
- GET  /v1/skills/registry    注册中心搜索
- POST /v1/skills/install     {namespace, slug}
- POST /v1/skills/uninstall   {name}
- POST /v1/chat (SSE)         {session_id?, message, history?}
    事件: phase / token / skill_load / tool / result / error / hb / done
- POST /v1/session/reset      {session_id}
"""

import asyncio
import hmac
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from openjiuwen.harness.deep_agent import Session

from . import mcp_client, skill_installer
from .agent_factory import manager
from .config import llm_config, registry_config, server_config
from .rails import current_emitter
from .sse import sse_encode, sse_heartbeat
from .tools import workspace_cwd

logger = logging.getLogger("skill-app-agent")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# 活跃会话（session_id → 最近活跃时间戳；仅生命周期管理，框架侧状态由 openjiuwen 维护）
_sessions: dict[str, float] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Skill App Agent 启动 | model=%s api_base=%s registry=%s",
                llm_config.model, llm_config.api_base, registry_config.base_url)
    if registry_config.auto_install:
        await _auto_install()
    yield


async def _auto_install() -> None:
    """启动时预置安装 AUTO_INSTALL_SKILLS（best-effort，重试 3 次）。"""
    for attempt in range(3):
        failed = False
        for pair in [p.strip() for p in registry_config.auto_install.split(",") if p.strip()]:
            namespace, _, slug = pair.partition("/")
            if not slug:
                logger.warning("AUTO_INSTALL_SKILLS 条目格式应为 namespace/slug: %s", pair)
                continue
            try:
                result = await skill_installer.install(namespace, slug)
                logger.info("auto installed %s/%s v%s", namespace, slug, result["version"])
            except FileExistsError:
                logger.info("auto install 跳过（已安装）: %s/%s", namespace, slug)
            except Exception as e:
                failed = True
                logger.warning("auto install %s/%s 失败（第 %d 次）: %s", namespace, slug, attempt + 1, e)
        if not failed:
            return
        await asyncio.sleep(3)


app = FastAPI(lifespan=lifespan, title="Skill App Agent", version="1.0.0")

_origins = ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


async def require_auth(request: Request) -> None:
    """Bearer 鉴权；未配置 GATE_TOKEN 时关闭鉴权（语义同 gate-service）。"""
    if not server_config.gate_token:
        return  # 鉴权关闭：未配置 GATE_TOKEN 即放行
    auth = request.headers.get("Authorization", "")
    if not hmac.compare_digest(auth, f"Bearer {server_config.gate_token}"):
        raise HTTPException(status_code=401, detail="鉴权失败：请在页面右上角设置访问令牌")


@app.get("/v1/healthz")
async def healthz():
    registry_status = "ok"
    try:
        await skill_installer.registry_client.search_skills("", limit=1)
    except Exception as e:
        registry_status = f"fail: {str(e)[:120]}"
    return {
        "status": "ok" if registry_status == "ok" else "degraded",
        "registry": registry_status,
        "llm": "configured" if llm_config.api_key else "missing_key",
        "model": llm_config.model,
        "installed": len(skill_installer.installed_skill_names()),
    }


@app.get("/v1/agent")
async def get_agent_profile(_: None = Depends(require_auth)):
    await manager.get_agent()  # 确保已构建
    return {
        "agent": {
            "id": "skill-app-agent",
            "name": "技能应用试运行助手",
            "description": "预置 OpenJiuWen DeepAgent：技能库技能安装后即注册给本 agent，可真实试运行 agent+skill 组合。",
            "model": llm_config.model,
            "capabilities": ["任务循环编排", "任务规划", "技能按需加载", "技能脚本执行"],
        },
        "skills": skill_installer.list_installed(),
        "sessions": len(_sessions),
    }


@app.get("/v1/mcp/status")
async def mcp_status(_: None = Depends(require_auth)):
    """MCP 接入状态：各技能 mcp_tools 声明 + 最近一次构建（连接/工具列表）报告。"""
    return mcp_client.last_status()


@app.get("/v1/skills/registry")
async def search_registry(q: str = "", limit: int = 20, _: None = Depends(require_auth)):
    try:
        return await skill_installer.registry_client.search_skills(q, limit)
    except Exception as e:
        logger.error("registry search failed: %s", e)
        raise HTTPException(status_code=502, detail=f"注册中心不可达: {str(e)[:200]}")


@app.post("/v1/skills/install")
async def install_skill(request: Request, _: None = Depends(require_auth)):
    body = await request.json()
    namespace = str(body.get("namespace") or "").strip()
    slug = str(body.get("slug") or "").strip()
    version = body.get("version") or None
    if not namespace or not slug:
        raise HTTPException(status_code=400, detail="namespace 与 slug 必填")
    try:
        result = await skill_installer.install(namespace, slug, version)
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error("install %s/%s failed: %s", namespace, slug, e, exc_info=True)
        raise HTTPException(status_code=502, detail=f"安装失败: {str(e)[:200]}")
    manager.invalidate()  # 指纹变化 → 下次对话重建 agent
    return {"installed": result, "skills": skill_installer.list_installed()}


@app.post("/v1/skills/uninstall")
async def uninstall_skill(request: Request, _: None = Depends(require_auth)):
    body = await request.json()
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name 必填")
    try:
        skill_installer.uninstall(name)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    manager.invalidate()
    return {"uninstalled": name, "skills": skill_installer.list_installed()}


@app.post("/v1/session/reset")
async def reset_session(request: Request, _: None = Depends(require_auth)):
    body = await request.json()
    sid = str(body.get("session_id") or "").strip()
    if sid:
        _sessions.pop(sid, None)
    return {"reset": sid or None}


def _chunk_text(payload: Any) -> str:
    """从 stream chunk payload 提取文本（str / dict / 对象属性探测）。"""
    if payload is None:
        return ""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for key in ("text", "content", "output"):
            v = payload.get(key)
            if isinstance(v, str):
                return v
        return ""
    for attr in ("text", "content", "output"):
        v = getattr(payload, attr, None)
        if isinstance(v, str):
            return v
    return ""


def _build_query(message: str, history: list) -> str:
    parts = ["【对话历史（仅供理解上下文）】"]
    for h in history[-20:]:
        if not isinstance(h, dict):
            continue
        role = str(h.get("role", ""))
        content = str(h.get("content", ""))[:2000]
        if role in ("user", "assistant") and content:
            parts.append(f"[{role}] {content}")
    parts.append("【当前用户消息】")
    parts.append(f"[user] {message}")
    return "\n".join(parts)


@app.post("/v1/chat")
async def chat(request: Request, _: None = Depends(require_auth)) -> StreamingResponse:
    try:
        body = await request.json()
    except Exception:
        body = {}
    message = str(body.get("message") or "").strip()
    session_id = str(body.get("session_id") or "").strip() or uuid.uuid4().hex[:12]
    history = body.get("history") or []
    if not isinstance(history, list):
        history = []

    async def err_stream(msg: str):
        yield sse_encode("error", {"error": msg})
        yield sse_encode("done", {})

    if not message:
        return StreamingResponse(err_stream("message is required"), media_type="text/event-stream")

    _sessions[session_id] = time.time()
    # 清理超过 1 小时的过期会话，防止 _sessions 无限增长
    _cutoff = time.time() - 3600
    for sid in list(_sessions):
        if _sessions[sid] < _cutoff:
            del _sessions[sid]

    async def event_stream():
        queue: asyncio.Queue = asyncio.Queue()
        error_holder: dict = {}

        async def emit(evt: dict) -> None:
            queue.put_nowait(evt)

        cv_token = current_emitter.set(emit)
        cv_cwd: object | None = None
        pump_task = None
        agent_stream = None
        try:
            yield sse_encode("phase", {"name": "初始化", "status": "running", "detail": "加载 Agent 与已安装技能"})
            agent = await manager.get_agent()
            cv_cwd = workspace_cwd.set(str(manager.workspace_dir))
            yield sse_encode("phase", {
                "name": "初始化", "status": "done",
                "detail": f"DeepAgent 就绪（技能 {len(skill_installer.installed_skill_names())} 个）",
            })
            session = Session(session_id=session_id, card=manager.card)
            query = _build_query(message, history)
            answer_parts: list[str] = []
            final_answer: str | None = None
            agent_stream = agent.stream({"query": query}, session=session)

            async def pump() -> None:
                nonlocal final_answer
                try:
                    async for chunk in agent_stream:
                        chunk_type = getattr(chunk, "type", None)
                        payload = getattr(chunk, "payload", None)
                        if chunk_type == "llm_output":
                            text = _chunk_text(payload)
                            if text:
                                answer_parts.append(text)
                                queue.put_nowait({"type": "token", "content": text})
                        elif chunk_type == "answer":
                            final_answer = _chunk_text(payload) or final_answer
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error("agent stream failed: %s", e, exc_info=True)
                    error_holder["error"] = f"Agent 运行失败：{str(e)[:300]}"
                    queue.put_nowait({"type": "error", "error": error_holder["error"]})

            pump_task = asyncio.create_task(pump())
            deadline = time.time() + server_config.agent_timeout
            last_hb = time.time()
            while True:
                try:
                    evt = await asyncio.wait_for(queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    evt = None
                if evt:
                    yield sse_encode(evt.pop("type"), evt)
                now = time.time()
                if now > deadline:
                    yield sse_encode("error", {"error": f"Agent 执行超时（{server_config.agent_timeout}秒）"})
                    break
                if now - last_hb > 15:
                    yield sse_heartbeat()
                    last_hb = now
                if pump_task.done() and queue.empty():
                    break
            # 泵剩余事件
            while not queue.empty():
                evt = queue.get_nowait()
                yield sse_encode(evt.pop("type"), evt)
            answer = ("".join(answer_parts)).strip() or (final_answer or "").strip()
            if error_holder.get("error") is None and not answer:
                yield sse_encode("error", {"error": "Agent 未产出回复"})
            if answer:
                yield sse_encode("phase", {"name": "回复生成", "status": "done", "detail": "完成"})
                yield sse_encode("result", {"answer": answer, "sessionId": session_id})
        except Exception as e:
            logger.error("chat stream exception: %s", e, exc_info=True)
            yield sse_encode("error", {"error": f"Agent 运行失败：{str(e)[:300]}"})
            return
        finally:
            if cv_cwd is not None:
                workspace_cwd.reset(cv_cwd)
            current_emitter.reset(cv_token)
            if pump_task is not None and not pump_task.done():
                pump_task.cancel()
                await asyncio.gather(pump_task, return_exceptions=True)
            if agent_stream is not None:
                try:
                    await agent_stream.aclose()
                except Exception:
                    pass
        yield sse_encode("done", {})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


def main():
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=server_config.host,
        port=server_config.port,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
