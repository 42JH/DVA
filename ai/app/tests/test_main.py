"""조립: BE 선택(가짜·실제·누락), lifespan에서 만들고 닫기."""

import pytest
from fastapi.testclient import TestClient

from app.config import load_server_config
from app.main import app, build_backend
from backend_client.api import BackendAPI
from backend_client.mock import MockBackend


def test_build_backend_choices():
    cfg = load_server_config().backend
    assert isinstance(build_backend(cfg, {"BACKEND_MOCK": "true"}).api, MockBackend)
    gw = build_backend(cfg, {"BACKEND_API_URL": "http://be", "AI_PERSONA_TOKEN": "", "AI_BUSINESS_TOKEN": "test-token"})
    assert isinstance(gw.api, BackendAPI) and gw.api.persona_token is None and gw.sem._value == cfg.max_concurrency
    with pytest.raises(RuntimeError, match="BACKEND_API_URL"):
        build_backend(cfg, {})
    with pytest.raises(RuntimeError, match="AI_BUSINESS_TOKEN"):
        build_backend(cfg.model_copy(update={"parcel_draft_intake": True}), {"BACKEND_API_URL": "http://be"})


def test_lifespan_and_healthz(monkeypatch):
    monkeypatch.setenv("BACKEND_MOCK", "true")
    with TestClient(app) as c:
        assert c.get("/healthz").json() == {"ok": True}
        assert app.state.svc.cfg.backend.timeout_sec > 0
        from app.domain.state import Items
        assert app.state.svc.fare_of({"items": Items(small_box_count=2)}) == 9900  # config [fare] 연결


def test_rag_wired_without_startup_check(monkeypatch):
    """RAG는 원본 RagService로 붙고, Qdrant·리랭커가 없어도 서버는 뜬다(기동 때 확인하지 않음, 사용자 지시 2026-11-03)."""
    from app.rag.service import RagService
    monkeypatch.setenv("BACKEND_MOCK", "true")
    monkeypatch.delenv("QDRANT_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(app) as c:
        assert isinstance(app.state.svc.rag, RagService) and app.state.svc.faq_processor is None
        assert c.post("/internal/faqs/refresh").status_code in (401, 503)  # 원본 FAQ 웹훅 라우트
