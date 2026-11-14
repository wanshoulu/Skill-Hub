"""配置管理 — LLM / 服务器 / 注册中心 / 技能库"""

import os
from dataclasses import dataclass


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (ValueError, TypeError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (ValueError, TypeError):
        return default


@dataclass
class LLMConfig:
    api_key: str = os.getenv("LLM_API_KEY", "")
    api_base: str = os.getenv("LLM_BASE_URL", "https://maas.qianwenaiapi.com/compatible-mode/v1")
    model: str = os.getenv("LLM_MODEL", "qwen3.7-flash")
    temperature: float = _env_float("LLM_TEMPERATURE", 0.4)
    max_tokens: int = _env_int("LLM_MAX_TOKENS", 8000)
    request_timeout: int = _env_int("LLM_REQUEST_TIMEOUT", 90)
    stream_first_chunk_timeout: int = _env_int("LLM_STREAM_FIRST_CHUNK_TIMEOUT", 60)
    stream_idle_timeout: int = _env_int("LLM_STREAM_IDLE_TIMEOUT", 60)
    max_retries: int = _env_int("LLM_MAX_RETRIES", 2)


@dataclass
class ServerConfig:
    host: str = os.getenv("HOST", "0.0.0.0")
    port: int = _env_int("PORT", 8310)
    # Bearer 鉴权，与 gate-service 同源（前端 localStorage gateToken）；未配置则服务拒绝启动对外 API
    gate_token: str = os.getenv("GATE_TOKEN", "")
    agent_timeout: int = _env_int("AGENT_TIMEOUT", 300)


@dataclass
class StorageConfig:
    skills_root: str = os.getenv("SKILLS_DIR", "/data/skills")
    workspace_root: str = os.getenv("WORKSPACE_DIR", "/data/workspace")


@dataclass
class RegistryConfig:
    base_url: str = os.getenv("REGISTRY_BASE_URL", "http://server:8080").rstrip("/")
    # 预留：私有技能拉取令牌（MVP 仅匿名公开技能）
    token: str = os.getenv("REGISTRY_TOKEN", "")
    # 启动时自动安装，逗号分隔 namespace/slug
    auto_install: str = os.getenv("AUTO_INSTALL_SKILLS", "")


llm_config = LLMConfig()
server_config = ServerConfig()
storage_config = StorageConfig()
registry_config = RegistryConfig()
