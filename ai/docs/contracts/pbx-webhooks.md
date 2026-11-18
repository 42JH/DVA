# PBX·OpenAI 웹훅 연동 계약 (현행)

작성일: 2026-11-03 · 근거: 저장소 코드(`pbx_webhook/`)와 `docs/be-contract/ai/pbx-sip.md`, `docs/be-contract/backend/ai-pbx-recordings.md`, `active-call-count.md`
표기: **[코드]** 실제 구현에서 확인 · **[문서]** 문서에만 있음 · **확인 필요** 코드·문서 어디에도 근거 없음

> 이 문서의 외부 인터페이스(경로·인증·본문·응답 코드)는 재설계 후에도 유지해야 하는 계약이다.
> OpenAI 쪽 동작은 저장소에 적힌 내용만 옮겼다. 저장소 밖 OpenAI 문서로 검증하지 않았다(`pbx-sip.md` 스스로 일부를 "미확인"으로 표시).

---

## 0. 전체 그림

```
PBX ──SIP(TLS 5061, SRTP)──▶ OpenAI GPT-Live SIP ──webhook: live.transport.incoming──▶ AI 서버
                                                                                       │ accept/reject/hangup/refer (REST)
                                                                                       │ sideband WebSocket(attach)
PBX ──HTTP POST /pbx/webhook/call-ended (Bearer)───────────────────────────────────────▶ AI 서버
PBX ──같은 본문──▶ BE(녹취·통화 연결)                                                     (AI ▶ BE: REST, be-api.md)
```

- 통화 시작 신호: OpenAI 웹훅 `live.transport.incoming` (PBX가 직접 AI에 보내지 않음). [문서 `pbx-sip.md`]
- 통화 종료 신호: OpenAI는 종료 웹훅을 보내지 않는다. sideband `session.closed` 또는 PBX 종료 웹훅. [문서 `pbx-sip.md` "PBX → 서버"]

---

## 1. OpenAI SIP 수신 웹훅 (OpenAI → AI)

| 항목 | 값 | 근거 |
|---|---|---|
| 메서드·경로 | `POST /api/webhooks/openai/call-incoming` (라우터 인수 `path`로 변경 가능, 기본값) | [코드] `pbx_webhook/incoming.py:49` |
| 인증 | Standard Webhooks 서명: `webhook-id`, `webhook-timestamp`, `webhook-signature` 헤더. `client.webhooks.unwrap(body, headers)`로 **원문 바이트** 검증 | [코드] `incoming.py:58-63`, [문서] `pbx-sip.md` |
| 비밀값 | `OPENAI_WEBHOOK_SECRET` → `AsyncOpenAI(webhook_secret=...)` | [문서] `README.md` 환경변수 표 |
| 처리 대상 이벤트 | `event.type ∈ {"live.transport.incoming", "live.call.incoming"}` **그리고** `event.data.type == "sip"` | [코드] `incoming.py:17,66` |
| 무시 이벤트 | 그 밖 전부(예: 같은 통화로 올 수 있는 `realtime.call.incoming`) → 200 | [코드] `incoming.py:72`, [문서] `pbx-sip.md` |
| 사용 필드 | `data.session_id`, `data.sip_headers[]`(`name`,`value`), `created_at`(Unix 초) | [코드] `incoming.py:67-68` |
| 중복 제거 | `webhook-id` 헤더 기준, 메모리 TTL 3600초(`dedupe_sec`). 헤더 없으면 항상 처리 | [코드] `incoming.py:30-46,64` |
| 응답 | 서명 실패 400 · 중복 200 · 처리 200(콜백은 백그라운드) | [코드] `incoming.py:61-73` |
| 재시도(OpenAI 측) | "몇 초 안에 2xx를 주지 않으면 72시간까지 재시도" | [문서] `pbx-sip.md` (OpenAI 원문 미검증) |

### 1.1 콜백으로 넘기는 값 `IncomingCall` [코드 `incoming.py:20-26`]

| 필드 | 타입 | 의미 |
|---|---|---|
| `session_id` | str | OpenAI Live 세션 ID. BE `call.providerCallId`로 그대로 사용 |
| `caller` | str \| None | SIP `From`(또는 `f`) 헤더의 `sip:`/`sips:` 사용자부 → `normalize_caller` 결과. **미신뢰** |
| `incoming_at` | str \| None | `created_at`을 `iso_utc`로 변환(`...Z`). BE `call.incomingAt`. 최초 수신 값으로 고정해야 함 |
| `data` | Any | 이벤트 `data` 원본(`sip_headers`, `sip_media_security` 등) |

- 콜백 예외는 `log.exception`만 남기고 삼킨다(통화는 응답 없이 방치될 수 있음). [코드] `incoming.py:53-57`
- 백그라운드 작업은 라우터 내부 `tasks` 집합에만 보관. 종료(shutdown) 시 취소·대기 처리 없음. [코드] `incoming.py:51,69-71`

### 1.2 발신번호 정규화 [코드 `pbx_webhook/sip.py`]

- `caller_from_headers`: 첫 `From`/`f` 헤더에서 정규식 `sips?:([^@;>]+)` → 없으면 `None`. (`sip.py:11-19`)
- `normalize_caller`: 앞뒤 공백 제거, `+82` → `0`, 숫자 외 제거, 최대 15자리, 빈 값이면 `None`. **자릿수 유효성 검사는 하지 않음.** (`sip.py:22-27`)
- 주의: BE `caller-context`는 "숫자만, 선행 0 보존, 변환 후 3~20자리, `0082` 통일"을 요구한다(be-api.md 참조). 15자 절단 규칙과 BE 규칙의 차이는 **확인 필요**.

### 1.3 OpenAI 세션 제어 (AI → OpenAI) — 현 저장소 구현 범위

| 동작 | 저장소 구현 | 문서 기재 내용 |
|---|---|---|
| accept | **없음** (콜백의 몫) | `client.live.sessions.accept(session_id, session=...)`, `POST /v1/live/sessions/{id}/accept` 본문 `{"session": {...}}`, `session.type="live"` 필수, `audio.format` 빼기, 200 빈 본문 = 준비 완료 [문서 `pbx-sip.md`] |
| reject | **없음** | `reject(session_id, status_code=486)` 등. 먼저 한 결정만 유효(`decision_already_made`) [문서] |
| hangup | [코드] `hangup_quietly` — 404면 `False`, 그 외 예외 재발생 (`incoming.py:81-90`) | `POST .../hangup` 빈 본문 [문서] |
| refer(상담원 전환) | **없음** | `refer(session_id, target_uri="sip:...")`, 고객 동의 후에만 [문서] |
| sideband | **없음** | `wss://api.openai.com/v1/live/sessions/{id}/attach`, SDK `client.live.sideband.connect(session_id=...)`, `session.start` 보내지 않음 [문서] |
| 종료 이벤트 | **없음** | `session.closed`(이유 `close_requested`·`expired`·`content`·`remote_hangup`·`connection_lost`) [문서] |
| DTMF | **없음** | sideband `transport.dtmf.received`, 현재 미사용 [문서] |

- SDK 버전 고정: `openai[realtime]==3.35.1` (`pyproject.toml`). `pbx-sip.md`는 위 SDK 메서드를 "3.35.1에서 확인"이라 적었으나, 저장소 코드에서 직접 호출하는 것은 `webhooks.unwrap`와 `live.sessions.hangup`뿐이다.
- 문서상 한도(미검증): 동시 세션 Build 50·Launch 300·Grow 500, 컨텍스트 128K(90% 초과 시 엔진 교체), `session.started.expires_at`. [문서 `pbx-sip.md`]

---

## 2. PBX 통화 종료 웹훅 (PBX → AI)

| 항목 | 값 | 근거 |
|---|---|---|
| 메서드·경로 | `POST /pbx/webhook/call-ended` (인수로 변경 가능) | [코드] `call_ended.py:31` |
| 인증 | `Authorization: Bearer <PBX_WEBHOOK_SECRET>`, `hmac.compare_digest` 상수 시간 비교, scheme 대소문자 무시 | [코드] `call_ended.py:40-45`, `sip.py:39-43` |
| 비밀값 미설정 | 503 (요청 처리 거부) | [코드] `call_ended.py:37-39` |
| 본문 | JSON. PBX가 BE에 보내는 것과 같은 본문 | [문서] `pbx-sip.md` |
| 응답 | 200 처리(모르는/이미 끝난 통화 포함, 재전송 안전) · 400 본문 오류 · 401 토큰 오류 · 503 비밀값 없음 | [코드] `call_ended.py`, [문서] `pbx-sip.md` |
| 재시도(PBX 측) | **확인 필요** (PBX가 비 2xx에 재전송하는지 문서 없음) | — |

### 2.1 본문 스키마

문서 예시 [문서 `pbx-sip.md`]:
```json
{"recordingId": "...", "callFrom": "01012345678", "callTo": "070XXXXXXXX",
 "startedAt": "2026-03-25T15:30:00Z", "endedAt": "2026-03-25T15:33:00Z",
 "durationSeconds": 180, "recordingUrl": "https://..."}
```

검증 모델 `CallEnded` [코드 `call_ended.py:19-28`] — 나머지 필드는 무시(extra 허용):

| 필드 | 필수 | 검증 |
|---|---|---|
| `callFrom` | 예 | str, 1~32자. `.caller` = `normalize_caller(callFrom)` (미신뢰) |
| `endedAt` | 예 | 시간대 포함 datetime(`AwareDatetime`) |
| `recordingId` | 아니오 | str ≤128자, 기록용 |

### 2.2 콜백 계약

- `on_call_ended(event)`는 **요청 안에서 await** 된다. 짧은 작업만(표시 후 끊기는 백그라운드). [코드] `call_ended.py:32,48`
- 콜백 예외 처리 없음 → FastAPI 500 응답. [코드] `call_ended.py:48`
- 통화 매칭 규칙(콜백 구현자의 의무): SIP Call-ID가 없으므로 **발신번호**로 찾고, 진행 중이며 `endedAt` **이전에 시작한** 통화만 끝낸다(같은 번호 재통화 보호). PBX·서버 시계 오차가 크지 않다는 가정. [문서] `pbx-sip.md`, [코드 docstring] `call_ended.py:4`
- 진행 중이면 마무리 인사를 기다리지 않고 즉시 `hangup`, accept 중이면 accept 완료 직후 `hangup`하고 sideband를 열지 않는다. [문서] `pbx-sip.md` — **현 저장소에는 이 로직이 없다.**

---

## 3. BE 쪽 PBX 관련 계약 (AI가 의존하는 부분)

- BE는 녹취와 통화를 `providerCallId`·`incomingAt`·발신번호로 잇는다. 따라서 AI는 `incomingAt`을 최초 수신 이벤트의 `created_at`으로 고정해야 한다. [문서] `caller-context.md`, `ai-pbx-recordings.md` (상세는 `be-api.md`)
- `active-call-count.md`의 요구 사항은 `be-api.md` §활성 통화 수 참조.

---

## 4. 확인 필요 목록

1. PBX 종료 웹훅의 재전송 정책(비 2xx 응답 시).
2. `normalize_caller`의 15자리 절단과 BE 3~20자리 규칙의 정합성.
3. OpenAI 웹훅 재시도·타임아웃 수치(문서 기재 "몇 초", "72시간")의 OpenAI 원문 근거.
4. `live.call.incoming`(구 이름)이 현재도 발송되는지.
5. 여러 인스턴스로 배포할 경우 `webhook-id` 중복 제거(현재 프로세스 메모리).
6. 공인 HTTPS 노출(리버스 프록시·OpenAI 프로젝트 웹훅 등록)은 "아직 하지 않음" [문서 `pbx-sip.md`] — 운영 경로 확인 필요.
