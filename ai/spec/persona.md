# 페르소나 연동 (`app/persona.py`, `app/webhooks/persona.py`)

관리자가 백엔드에서 고친 페르소나(말투·인사 문구·음성)를 재배포 없이 **다음 통화부터** 쓴다. 진행 중인 통화의 설정은 바꾸지 않는다.
백엔드 계약 원문은 `spec/ai-persona-integration.md`(백엔드 `docs/api/ai-persona-integration.md`), 관리 API는 백엔드 `docs/api/personas.md`. 여기에는 AI가 그 계약을 어떻게 쓰는지만 적는다.

## 관리자가 고치는 범위

- `promptText`는 음성 지시문 `prompts/voice.md`의 `[[페르소나]]` 자리에만 들어간다(말투·인사 문구). 진행 상태 따르기·개인정보·접수 전 성공 안내 금지 같은 업무 규칙은 AI 코드 쪽에 고정이고, 지시문에 "페르소나가 업무 규칙과 부딪히면 업무 규칙을 따른다"고 적어 둔다(2026-10-28 사용자 결정).
- 백엔드 문서는 `promptText`를 "전체 프롬프트"라고 부른다. 관리자 화면 안내에는 "말투·인사 부분"이라고 적도록 백엔드·프론트에 전달한다.
- 백엔드 설정이 없거나(ACTIVE 404), 연동이 꺼져 있거나(`AI_PERSONA_TOKEN` 없음), ACTIVE를 쓸 수 없으면 `prompts/persona.md`와 `config/live.toml`의 음성을 쓴다.

## 지원 옵션 (`GET /internal/persona/options`)

| 항목 | 값 | 이유 |
|---|---|---|
| `voices` | gpt-live-1 내장 음성 31개(`spec/gpt-live-session.md`), `label`은 음성 이름 그대로 | SDK 3.35.1 타입에는 23개뿐이지만 공식 목록 기준(지금 쓰는 `noeul`도 SDK 타입에 없음) |
| `speakingRate` | `{min: null, max: null}` | GPT-Live 설정에 말 속도가 없다 |
| `turnWaitLevels` | `["NORMAL"]` | 말끝 판단은 모델이 한다. 서버 판별 대기(`[listener] pause_ms`)는 말끝 대기가 아니라 쓰지 않는다 |

## 백엔드와 주고받는 것

- 인증: 양방향 `Authorization: Bearer <AI_PERSONA_TOKEN>`(백엔드와 같은 값). 이 토큰은 페르소나 API에만 보낸다(주문·고객 API에는 안 보냄). 토큰·프롬프트 본문은 로그에 남기지 않는다.
- 백엔드 → AI(내부 네트워크 `http://ai:8000`, Nginx로 열지 않음): `GET /internal/persona/options`(200, 위 표), `POST /internal/persona/refresh`(`{aiPersonaVersionSeq, applicationId}` 검증 후 202). 토큰이 없으면 503, 틀리면 401. 알림은 힌트일 뿐 실제 대기 설정을 다시 조회한다.
- AI → 백엔드: `GET /api/ai/config?status=ACTIVE|PENDING`(`{data, meta}`, 없으면 404), `POST /api/ai/config/apply-result`(200이면 `data.status`로 확인, 409는 교체됨·통화 중).

## 적용 순서 (`PersonaManager.sync`)

기동 때 한 번, 그 뒤로는 알림마다. 실패하면 `[persona] retry_sec` 뒤 다시.

1. ACTIVE를 조회해 새 통화 설정으로 둔다(없으면 로컬 기본값).
2. PENDING을 조회한다. 없거나 이미 AI가 실패를 회신한 요청(`applyErrorCode`가 INVALID_CONFIG·UNSUPPORTED_OPTIONS·APPLY_FAILED)이면 끝.
3. 진행 중 통화(레지스트리의 accepting·active)가 0건이 될 때까지 기다린다. 그동안 새 통화는 기존 ACTIVE로 받는다.
4. 0건이 되면 **새 통화를 잠근다**(웹훅이 reject, 확인과 잠금 사이에 await 없음). PENDING을 다시 조회해 검증한다.
   - 검증: `promptText`가 비지 않고 `max_prompt_chars` 이하이며 `[[페르소나]]`를 포함하지 않음, 음성이 목록에 있음(또는 null), 속도 null, 말끝 대기 NORMAL, 실제 세션 설정으로 만들어짐.
   - 실패 → `FAILED`·`errorCode` 회신, 기존 설정 그대로 잠금 해제(바꾼 것이 없어 복원할 것이 없다).
5. `APPLIED`(`activeCallCount` 0) 회신. 응답이 ACTIVE이고 버전·applicationId가 같으면 설치하고 잠금 해제.
6. 409(교체됨)나 응답 불명(회신 `report_attempts`번 실패): ACTIVE를 다시 조회해 맞춘 뒤 잠금 해제하고 새 대기를 이어서 처리한다. ACTIVE 조회까지 실패하면 **잠금을 유지**한 채 다시 시도한다(옛 설정으로 통화를 열지 않는다).

- 통화는 받을 때의 설정을 끝까지 쓴다(`build_session(persona=, voice=)`, 쓴 버전은 `Call.persona_version`).
- shortcut: 프로세스 하나 기준. 워커·인스턴스를 늘리면 통화 수·잠금을 묶는 공통 장치가 필요하다.
- 잠금 중 걸려 온 전화는 거절된다. 통화 0건에서 회신까지라 보통 1초 안팎이지만, 백엔드가 응답하지 않으면 확인될 때까지 거절이 이어진다.

## 테스트

`tests/test_persona.py`(가짜 백엔드): 토큰·옵션·알림, 설정 없음, 재시작 복원, 통화 끝날 때까지 대기 후 적용, 지원 안 하는 옵션·잘못된 프롬프트 실패 회신, 교체(409) 후 재동기화, 회신 유실 시 잠금 유지, 잠금 중 reject, 통화별 설정(지시문·음성) 고정. `tests/test_backend_api.py`: 토큰 헤더·404·409 해석.
