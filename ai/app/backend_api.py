"""원본 RAG(scripts/bootstrap_faq.py, tests/test_faq_source.py 등)가 import하는 `app.backend_api`의 호환판.
BE 클라이언트 구현은 backend_client.api에 있다(원본 app/backend_api.py에서 옮긴 것)."""

from backend_client.api import BackendAPI, BackendError

__all__ = ["BackendAPI", "BackendError"]
