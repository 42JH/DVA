# PBX(SIP) 연결

- PBX 쪽 설정(사용자·PBX 담당 몫): SIP 트렁크를 `sip:<proj_ 프로젝트 ID>@sip.api.openai.com;transport=tls`로 라우팅. TLS 시그널링(5061), SRTP 미디어 필수. 방화벽은 OpenAI 미디어 대역(`13.79.45.80/28`, `23.98.140.64/28`, `40.67.149.176/28`, `40.83.204.240/28`, UDP)을 허용. 프로젝트에서 GPT-Live SIP가 켜져 있어야 한다. (URI 형식·IP 대역은 Realtime SIP 문서 기준이라 **미확인**, 코덱도 문서에 없음)
- OpenAI 프로젝트 웹훅을 서버의 공인 HTTPS 주소로 등록하고, 이벤트 `live.transport.incoming`을 구독한다. 비밀값은 `OPENAI_WEBHOOK_SECRET`.
- 웹훅 처리:
  - 본문을 파싱하기 전에 원문으로 서명 검증: `client.webhooks.unwrap(body, headers)`(`webhook-id`·`webhook-timestamp`·`webhook-signature`). 실패하면 400.
  - 몇 초 안에 2xx를 주지 않으면 72시간까지 재시도된다. 바로 200을 주고 accept는 백그라운드 작업으로. `webhook-id`로 중복 제거.
  - `live.transport.incoming`(`data.type = "sip"`, `data.session_id`, `data.sip_headers`)를 처리한다. 예전 이름 `live.call.incoming`도 같이 받는다. 같은 통화로 `realtime.call.incoming`이 올 수 있으니 무시한다.
  - 웹훅 타입은 SDK의 `LiveTransportIncomingWebhookEvent`(`data.sip_media_security`도 옴).
  - 발신번호는 `sip_headers`의 `From`에서 뽑는다. **미신뢰 값**: 숫자만 남기고(`+82` → `0`) 길이를 제한한 뒤 지시문·조회에 쓴다. 인증 근거로 쓰지 않는다.
- accept: `POST /v1/live/sessions/{session_id}/accept`, 본문 `{"session": {...}}`(`audio.format` 빼기). 200 빈 본문이 세션 준비 완료. 오류면 통화를 못 받은 것으로 기록. 거절은 `.../reject` `{"status_code": 486}` 등. 먼저 한 결정만 유효(`decision_already_made`).
- sideband: `wss://api.openai.com/v1/live/sessions/{session_id}/attach`(Bearer API 키, `session.start` 보내지 않음). SDK `client.live.sideband.connect(session_id=...)`.
- 종료: `POST .../hangup`(빈 본문). 또는 `session.close` 후 `session.closed`(이유: close_requested·expired·content·remote_hangup·connection_lost, 사용 초) 대기. 고객이 먼저 끊으면 `remote_hangup`.
- 상담원 전환: `POST .../refer` `{"target_uri": "sip:..."}`. 대상은 서버 설정. 고객 동의 후에만.
- DTMF: sideband로 `transport.dtmf.received`(`event` 0-9·*·#·A-D) 알림만 온다. 지금은 쓰지 않는다.
- SDK 메서드(openai 3.35.1에서 확인): `client.live.sessions.accept(session_id, session=...)` · `reject(session_id, status_code=...)` · `refer(session_id, target_uri=...)` · `hangup(session_id)`. accept 본문의 `session`에는 `type = "live"`가 필수다.
- 웹훅 주소는 서버의 `POST /api/webhooks/openai/call-incoming`(구현 `app/webhooks/openai.py`). 공인 HTTPS 연결(리버스 프록시·OpenAI 프로젝트 등록)은 아직 하지 않았다.
- 한도: 동시 세션 Build 50·Launch 300·Grow 500. 과금 분당 $0.05(초 단위), 백엔드 모델 별도. 컨텍스트 128K, 90%를 넘으면 같은 세션에서 엔진이 교체된다(원래 지시문 + 최근 8,192토큰). `session.started`의 `expires_at`이 세션 만료 시각.

## PBX → 서버: 통화 종료 웹훅

OpenAI는 통화 종료 웹훅을 보내지 않는다(종료는 sideband `session.closed`로만 옴). PBX가 팀 백엔드에 보내는 통화 종료 웹훅을 같은 본문으로 우리 서버에도 보낸다. 아직 진행 중인 세션이 있으면 서버가 바로 끝낸다(보통은 `session.closed`로 먼저 끝나 있다). 구현: `app/webhooks/pbx.py`, 테스트 `tests/test_pbx.py`.

- 주소: `POST https://<서버 도메인>/pbx/webhook/call-ended`. 리버스 프록시에서 이 경로를 공개한다.
- 인증(필수): `Authorization: Bearer <PBX_WEBHOOK_SECRET>`. 공유 토큰은 길고 무작위한 값으로, PBX 쪽과 같은 값.
- 본문(JSON, PBX 형식): `{"recordingId": "...", "callFrom": "01012345678", "callTo": "070XXXXXXXX", "startedAt": "2026-03-25T15:30:00Z", "endedAt": "2026-03-25T15:33:00Z", "durationSeconds": 180, "recordingUrl": "https://..."}`
  - 서버가 쓰는 것: `callFrom`(필수, 미신뢰 값: 숫자만·`+82` → `0`), `endedAt`(필수, 시간대 있는 ISO 8601), `recordingId`(기록용). 나머지는 무시.
  - 통화 찾기: SIP Call-ID가 없어서 **발신번호**로 찾는다. 진행 중이고 발신번호가 같으며 `endedAt` 전에 시작한 통화만 끝낸다.
  - 웹훅은 녹취 파일이 준비된 뒤라 통화가 끊기고 몇 초 늦게 온다. 그사이 같은 번호로 다시 건 통화는 `endedAt` 뒤에 시작했으므로 끊지 않는다(PBX와 서버 시계가 크게 어긋나지 않는다는 가정).
- 응답
  - 200: 처리함. 모르는 통화·이미 끝난 통화도 200이고, 같은 요청을 다시 보내도 된다.
  - 401: 토큰 오류. 400: 본문 오류. 503: 서버에 토큰이 설정되지 않음.
- 동작
  - 진행 중인 통화면 마무리 인사를 기다리지 않고 바로 `hangup`. 보통은 OpenAI가 고객의 SIP 종료로 세션을 이미 닫아서 404(`session_id_not_found`)이고, 이는 오류로 남기지 않는다.
  - accept 중인 통화면 accept가 끝나는 대로 `hangup`하고 sideband를 열지 않는다.
  - 관제 화면에 `pbx_ended`(`ended_at`, `recording_id`)로 남긴다.
