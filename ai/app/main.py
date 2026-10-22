"""FastAPI 하나: PBX(OpenAI) 웹훅, 관제 API·SSE, 관제 화면. 워커 1개로 띄운다."""

import logging
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI

from app.call import Call, Registry
from app.config import load_server_config, load_texts
from app.flow import engine
from app.live_session import LiveConfigError, function_tool_names, load_live_toml
from app.monitor.router import router as monitor_router
from app.pbx import router as pbx_router
from app.tools._base import TOOLS, load_tools
from app.webhook import Services
from app.webhook import router as webhook_router

log = logging.getLogger(__name__)


def check_definitions(cfg, texts) -> None:
    """기동 시 검증: 단계·도구·문구가 서로 맞는지, live.toml의 함수 도구가 모두 있는지. 실패하면 기동을 멈춘다."""
    load_tools()
    engine.load_stages()
    sample = Call("startup-check", None, cfg, texts, None).text_vars()
    engine.validate(set(TOOLS), texts, sample)
    texts.call_info.format(**sample)
    unknown = [n for n in function_tool_names(load_live_toml()) if n not in TOOLS]
    if unknown:
        raise LiveConfigError(f"live.toml에 없는 함수 도구: {unknown}")


def create_app(client: Any = None, backend: Any = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        cfg = load_server_config()
        logging.basicConfig(level=cfg.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
        texts = load_texts()
        check_definitions(cfg, texts)
        openai_client, backend_api = client, backend
        if openai_client is None:
            from openai import AsyncOpenAI

            openai_client = AsyncOpenAI()  # OPENAI_API_KEY, OPENAI_WEBHOOK_SECRET
        if backend_api is None:
            from app.backend_api import BackendAPI

            backend_api = BackendAPI(os.environ["BACKEND_API_URL"], cfg.backend.timeout_sec)
        app.state.svc = Services(cfg, texts, openai_client, backend_api, Registry(cfg))
        try:
            yield
        finally:
            if backend is None:
                await backend_api.close()

    app = FastAPI(title="디포스트콜 전화 접수", lifespan=lifespan)
    app.include_router(webhook_router)
    app.include_router(pbx_router)
    app.include_router(monitor_router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "service": "ai-agent"}

    return app


app = create_app()
