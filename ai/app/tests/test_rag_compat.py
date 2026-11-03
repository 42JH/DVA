"""우리 쪽 호환 모듈(app/config.py, app/backend_api.py, app/webhooks/pbx.py)이 원본 RAG(수정 금지)와 맞물리는지.
원본 RAG 자체의 테스트는 tests/(원본 그대로)에 있다."""

import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import ROOT, load_server_config
from app.rag.faq_events import FaqEventStore
from app.webhooks import faqs

TOKEN = "t" * 40


def test_server_toml_loads_original_rag_sections():
    cfg = load_server_config()
    assert cfg.rag.collection == "manuals_dev_openai_large" and cfg.faq_sync.collection == "manuals_backend_faq_large"
    assert (ROOT / "manuals/delivery_faq.md").is_file() and (ROOT / "config/rag-search-descriptions.json").is_file()


def make_client(tmp_path, monkeypatch, token=TOKEN):
    """원본 faqs 라우터가 읽는 app.state.svc(cfg.faq_sync, faq_events, faq_processor) 모양을 우리 쪽이 만들어 준다."""
    if token:
        monkeypatch.setenv("AI_FAQ_TOKEN", token)
    else:
        monkeypatch.delenv("AI_FAQ_TOKEN", raising=False)
    cfg = load_server_config()
    store = FaqEventStore(tmp_path / "faq.sqlite3", max_pending=cfg.faq_sync.max_pending,
                          busy_timeout_sec=cfg.faq_sync.busy_timeout_sec)
    app = FastAPI()
    app.state.svc = SimpleNamespace(cfg=cfg, faq_events=store, faq_processor=None)
    app.include_router(faqs.router)
    return TestClient(app)


def test_original_faq_webhook_runs_on_compat_modules(tmp_path, monkeypatch):
    body = {"eventId": str(uuid.uuid4()), "operation": "INSERT", "faqEntrySeqs": [1, 2]}
    c = make_client(tmp_path, monkeypatch)
    assert c.post("/internal/faqs/refresh", json=body).status_code == 401
    ok = {"authorization": f"Bearer {TOKEN}"}
    assert c.post("/internal/faqs/refresh", json=body, headers=ok).status_code == 202
    assert c.post("/internal/faqs/refresh", json=body, headers=ok).status_code == 202  # 같은 eventId 재수신
    assert c.post("/internal/faqs/refresh", json={**body, "faqEntrySeqs": [3]}, headers=ok).status_code == 409
    assert c.post("/internal/faqs/refresh", json={"eventId": "x"}, headers=ok).status_code == 400


def test_original_faq_webhook_closed_without_token(tmp_path, monkeypatch):
    c = make_client(tmp_path, monkeypatch, token=None)
    assert c.post("/internal/faqs/refresh", json={}).status_code == 503


def test_backend_api_reexport_has_original_faq_methods():
    from app.backend_api import BackendAPI

    assert callable(BackendAPI.faq_entries) and callable(BackendAPI.initial_faq_entries)
