"""전화 수신 웹훅. OpenAI SIP 수신(live.transport.incoming)과 PBX 통화 종료 웹훅을 검증·파싱해 콜백으로 넘긴다.
세션 설정(accept 본문)·sideband·통화 상태는 이 모듈 밖(재구성할 서버)의 몫이다. 원본: ai/app/webhooks/openai.py·pbx.py."""

from pbx_webhook.call_ended import CallEnded, create_call_ended_router
from pbx_webhook.incoming import IncomingCall, create_incoming_router, hangup_quietly
from pbx_webhook.sip import caller_from_headers, iso_utc, mask_phone, normalize_caller, token_ok

__all__ = ["CallEnded", "IncomingCall", "caller_from_headers", "create_call_ended_router", "create_incoming_router",
           "hangup_quietly", "iso_utc", "mask_phone", "normalize_caller", "token_ok"]
