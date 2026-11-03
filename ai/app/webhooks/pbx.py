"""원본 app/webhooks/faqs.py(RAG 담당, 수정 금지)가 import하는 `app.webhooks.pbx.token_ok`의 호환판.
PBX 웹훅 구현은 pbx_webhook/에 있고 token_ok도 원본과 같은 동작이다(Bearer, 상수 시간 비교)."""

from pbx_webhook.sip import token_ok

__all__ = ["token_ok"]
