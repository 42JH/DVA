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
- 웹훅 주소는 서버의 `POST /openai/webhook`. 공인 HTTPS 연결(리버스 프록시·OpenAI 프로젝트 등록)은 아직 하지 않았다.
- 한도: 동시 세션 Build 50·Launch 300·Grow 500. 과금 분당 $0.05(초 단위), 백엔드 모델 별도. 컨텍스트 128K, 90%를 넘으면 같은 세션에서 엔진이 교체된다(원래 지시문 + 최근 8,192토큰). `session.started`의 `expires_at`이 세션 만료 시각.
