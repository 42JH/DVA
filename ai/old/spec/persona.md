# 페르소나 연동 (`app/persona.py`, `app/webhooks/persona.py`)

관리자가 백엔드에서 고친 페르소나(음성 지시문 전체·음성)를 재배포 없이 **다음 통화부터** 쓴다. 진행 중인 통화는 시작할 때 고정한 설정으로 끝까지 간다.
백엔드 계약 원문은 `spec/ai-persona-next-call.md`(AI 연동), `spec/persona-head-management.md`(관리자 HEAD·publish, AI 코드와는 무관). 여기에는 AI가 그 계약을 어떻게 쓰는지만 적는다.

## 관리자가 고치는 범위

- `promptText`는 음성 지시문 **전체**다. `prompts/voice.md`를 통째로 대신하고, 끝에 통화 정보(`call_info`)만 서버가 붙인다(2026-11-01 사용자 결정, 이전의 `[[페르소나]]` 자리 방식은 버림).
- 그래서 관리자 프롬프트는 `prompts/voice.md`를 바탕으로 고쳐야 한다(진행 상태 따르기·통화 정보·첫 질문 규칙을 지우면 흐름이 깨진다). 코드에서 강제하는 안전장치(AGENTS.md)는 프롬프트와 상관없이 그대로다.
- 백엔드 설정이 없을 때:
  - 연동이 꺼져 있으면(`AI_PERSONA_TOKEN` 없음, 개발용) `prompts/voice.md`와 `config/live.toml` 음성.
  - 연동이 켜져 있는데 ACTIVE·PENDING이 다 없거나 ACTIVE를 쓸 수 없으면 **새 통화를 거절**한다(2026-11-01 사용자 결정).

## 지원 옵션 (`GET /internal/persona/options`)

| 항목 | 값 | 이유 |
|---|---|---|
| `voices` | gpt-live-1 내장 음성 31개(`spec/gpt-live-session.md`), `label`은 음성 이름 그대로 | SDK 3.35.1 타입에는 23개뿐이지만 공식 목록 기준(지금 쓰는 `noeul`도 SDK 타입에 없음) |
| `speakingRate` | `{min: null, max: null}` | GPT-Live 설정에 말 속도가 없다 |
| `turnWaitLevels` | `["NORMAL"]` | 말끝 판단은 모델이 한다. 서버 판별 대기(`[listener] pause_ms`)는 말끝 대기가 아니라 쓰지 않는다 |

## 백엔드와 주고받는 것

- 인증: 양방향 `Authorization: Bearer <AI_PERSONA_TOKEN>`(백엔드와 같은 값). 이 토큰은 페르소나 API에만 보낸다(주문·고객 API에는 안 보냄). 토큰·프롬프트 본문은 로그에 남기지 않는다.
- 백엔드 → AI(내부 네트워크 `http://ai:8000`, Nginx로 열지 않음): `GET /internal/persona/options`(200, 위 표), `POST /internal/persona/refresh`(`{aiPersonaVersionSeq, applicationId}` 검증 후 202). 토큰이 없으면 503, 틀리면 401. 알림은 힌트일 뿐 실제 대기 설정을 다시 조회한다.
- AI → 백엔드: `GET /api/ai/config?status=ACTIVE|PENDING`(`{data, meta}`, 없으면 404), `POST /api/ai/config/apply-result`(`aiPersonaVersionSeq`·`applicationId`·`result`, FAILED면 `errorCode`. `activeCallCount`는 보내지 않는다. 200이면 `data.status`로 확인, 409는 교체됨).

## 적용 순서 (`PersonaManager`)

알림 처리(`run`: 기동 때 한 번, 그 뒤 알림마다)와 새 통화 진입(`entry`)이 **같은 `asyncio.Lock`**을 쓴다. 진행 중 통화 수는 보지 않는다.

`sync`(잠금 안):
1. ACTIVE를 아직 확인하지 않았거나 앞선 회신이 불명확하면 ACTIVE를 조회해 새 통화 기본값으로 둔다.
2. PENDING을 조회한다. 없거나 이미 AI가 실패를 회신한 요청(`applyErrorCode`가 INVALID_CONFIG·UNSUPPORTED_OPTIONS·APPLY_FAILED)이면 끝(불명확 표시도 푼다: 방금 본 ACTIVE가 결과).
3. 검증: `promptText`가 비지 않고 `max_prompt_chars` 이하, 음성이 목록에 있음(또는 null), 속도 null, 말끝 대기 NORMAL, 실제 세션 설정으로 만들어짐. 실패 → `FAILED`·`errorCode` 회신, 기본값은 그대로.
4. "불명확"으로 표시하고 `APPLIED` 회신. 응답이 ACTIVE이고 버전·applicationId가 같으면 새 통화 기본값을 바꾸고 표시를 푼다.
5. 409(교체됨): 1부터 다시(최대 `report_attempts`번). 회신 연결 실패(`report_attempts`번)나 응답이 요청과 다르면 예외, "불명확"이 남는다. 다음 동기화에서 ACTIVE를 확인하거나 같은 APPLIED를 다시 보내(백엔드 멱등) 푼다.

- ACTIVE는 이 프로세스의 APPLIED 회신으로만 바뀌므로 통화 진입 때는 PENDING만 조회한다(처음·불명확할 때만 ACTIVE도). 통화당 백엔드 GET 1번이 늘어난다.
- `run`은 실패하면 `retry_sec` 뒤 다시 한다.

## 통화 진입 (`handle_incoming` → `PersonaManager.entry`)

1. 잠금을 `entry_wait_sec` 안에 못 잡으면 거절.
2. `sync`를 `entry_wait_sec` 안에서 실행. 조회가 실패·시간 초과하면 **캐시된 기본값으로 받는다**(2026-11-01 사용자 결정, 페르소나 조회 장애로 전화 전체가 막히지 않게). 백그라운드 동기화를 깨운다.
3. 회신 결과가 불명확하거나 기본값이 없으면 거절(옛 캐시로 열지 않는다).
4. 잠금을 쥔 채 이 통화의 설정을 고정(`Call.persona_version`)하고 레지스트리에 등록한 뒤 잠금을 푼다. 이후 고객 확인·accept는 잠금 밖.

- 통화는 받을 때의 설정을 끝까지 쓴다(`build_session(persona=, voice=)`).
- 분석(ANL-01, 백엔드 `POST /api/ai/calls/{id}/analysis`)의 `aiPersonaVersionSeq`에는 `Call.persona_version`(시작 때 고정한 값)을 보내야 한다. 아직 AI는 분석 API를 부르지 않는다(별도 작업).
- shortcut: 프로세스 하나 기준. 워커·인스턴스를 늘리면 기본값 전환과 통화 진입을 묶는 공통 장치가 필요하다.

## 테스트

`tests/test_persona.py`(가짜 백엔드): 토큰·옵션·알림, 설정 없음 거절, 연동 꺼짐, 재시작 복원·PENDING만 있을 때 적용, 알림 전 통화 진입 적용(회신에 통화 수 없음), 지원 안 하는 옵션·잘못된 프롬프트 실패 회신, 교체(409) 뒤 최신 적용, 회신 유실 동안 거절 후 확인, 조회 실패 시 캐시, 동기화 중 진입 대기, 진행 통화와 무관하게 새 통화는 새 버전(지시문 전체·음성). `tests/test_backend_api.py`: 토큰 헤더·404·409 해석.
