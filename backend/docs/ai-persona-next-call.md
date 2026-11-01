# AI 팀 전달: 페르소나를 다음 통화부터 적용

2026-11-01 최신 AI 연동 계약이다. **진행 중 통화는 기존 버전을 유지하고 새 통화의 기본 버전만 전환한다.** AI URL·인증은 유지하며 activeCallCount는 생략 가능한 호환 필드로 남긴다. 관리자 유형별 HEAD·publish는 [관리 계약](persona-head-management.md)을 따른다. 이 작업은 백엔드와 전달 명세까지이며 AI 코드·실제 서버 배포는 포함하지 않는다.

## 원하는 동작

| 시점 | 통화 A | 새로 시작하는 통화 B |
| --- | --- | --- |
| 버전 1 사용 중 | 버전 1로 진행 | 버전 1 사용 |
| 관리자가 버전 2 적용 요청 | 버전 1 유지 | 통화 진입 시 대기 설정을 먼저 동기화 |
| AI가 버전 2 전환을 확인 | 버전 1로 끝까지 진행 | 버전 2로 시작 |

`ACTIVE`는 **새 통화에 사용할 기본 버전**이다. 이미 진행 중인 모든 통화가 같은 버전을 쓴다는 뜻이 아니다. `PENDING`은 AI 확인 전 대기 버전이며 알림 수신·HTTP 202만으로 적용 완료가 아니다. 적용 요청 커밋 이후 시작하는 통화가 새 버전을 사용하도록, 통화 시작 시점에도 설정을 확인해야 한다.

## 현재 AI 코드에서 바꿀 부분

2026-11-01 확인한 원격 `develop-ai` 기준이며 이후 AI 변경·배포 여부를 의미하지 않는다.

- `ai/app/persona.py`: `PersonaManager.sync()`의 `while registry.active_count() > 0` 대기가 있다. 이 대기를 제거하고 기존 통화가 있어도 새 통화의 기본 설정을 전환해야 한다.
- `ai/app/webhooks/openai.py`: 새 통화가 `persona.active`를 읽어 `call.persona_version`에 고정한다. 이 고정은 유지하되, 캐시를 읽기 전에 백엔드의 최신 ACTIVE/PENDING을 동기화해야 한다.
- 기존 알림 처리와 통화 진입 동기화가 동시에 실행될 수 있으므로 같은 설정 전환 잠금으로 직렬화해야 한다. 단순 `locked` boolean만으로 여러 비동기 동기화 작업 사이의 경쟁까지 막는다고 가정하지 않는다.

## 통화 진입과 적용 순서

1. 알림을 받았을 때와 **새 통화가 시작할 때** 동일한 설정 전환·통화 진입 잠금을 사용한다. 기존 통화의 음성 처리·종료까지 이 잠금을 잡고 기다리지 않는다.
2. 백엔드 ACTIVE/PENDING을 다시 조회한다. 알림의 버전 번호는 힌트이며, 이미 교체된 요청을 그대로 적용하지 않는다.
3. PENDING이 있으면 전체 프롬프트·음성·옵션을 검증하고 새 통화에 쓸 후보 설정을 준비한다. 기존 통화의 설정 객체나 OpenAI 세션은 수정하지 않는다.
4. 신규 통화 진입을 막은 상태에서 아래 APPLIED를 회신한다. **activeCallCount가 0이 될 때까지 기다리지 않는다.**
5. 같은 버전·applicationId의 ACTIVE 응답을 확인한 뒤 새 통화의 기본 설정 참조를 교체한다.
6. 통화마다 설정과 `aiPersonaVersionSeq`를 고정하고 통화 등록까지 같은 진입 잠금으로 보호한다. 이후 다른 기본 버전이 적용되어도 이미 시작한 통화는 바꾸지 않는다.

여러 적용 요청과 통화 시작이 겹치면 최신 PENDING 및 applicationId를 다시 확인한다. 적용 요청과 동시에 이미 시작된 통화는 그 통화 진입 시 확정한 버전을 유지한다. 주기 알림만 기다리면 알림 도착 전 새 통화가 옛 버전으로 시작할 수 있으므로, **통화 시작 시 조회를 생략하면 이 요구사항을 보장할 수 없다.**

## 백엔드 API

- 양방향 `Authorization: Bearer <AI_PERSONA_TOKEN>`. 32자 이상 무작위 ASCII 토큰을 비밀 환경변수로 공유한다. 토큰·프롬프트 본문은 로그에 남기지 않는다.
- AI → BE 기준 경로는 `/api`, BE → AI는 `AI_AGENT_URL` + `/internal`이다. `/v1`은 붙이지 않는다.
- AI 요청에는 관리자 쿠키·Origin을 넣지 않는다. 이 토큰은 페르소나 연동 전용이며 주문·관리자 편집 권한을 주지 않는다.

관리자 publish는 `POST /api/personas/{id}/activate`로 확인한 최신 확정 HEAD를 선택한다. 초안 저장은 HEAD를 바꾸지 않으며, 초안 확정으로 HEAD가 이동해도 실제 상담 버전과 이미 수락한 PENDING·UUID는 바뀌지 않는다. AI는 설정 조회의 ACTIVE/PENDING을 따르고 작성 중 초안은 받지 않는다.

| API | 의미 |
| --- | --- |
| GET /api/ai/config?status=ACTIVE | 신규 통화의 현재 기본 설정. 없으면 404 |
| GET /api/ai/config?status=PENDING | 적용 대기 전체 설정과 applicationId. 없으면 404 |
| POST /api/ai/config/apply-result | 준비한 신규 통화 기본 설정의 적용·실패 회신 |

위 API 응답은 `{ data, meta: { requestId } }`다. AI 응답에는 관리자 작성자 이름을 추가하지 않는다.

```json
{
  "aiPersonaVersionSeq": 23,
  "applicationId": "50ee1b2f-8dd2-4b9c-8a19-c7bc193ee15b",
  "result": "APPLIED"
}
```

성공 회신에는 aiPersonaVersionSeq, applicationId, result가 필수다. 현재 통화가 있어도 허용하며 activeCallCount는 필요 없다. 기존 AI가 전송하는 경우에는 0 이상 정수만 허용하지만 저장하거나 적용 여부 판단에 사용하지 않는다. null·문자열·음수는 400이다. Swagger에는 deprecated로 표시한다. 성공 응답의 `data.status`는 ACTIVE이고 `data.aiPersonaVersionSeq`·`applicationId`가 같은 요청인지 확인한다.

- 동일 APPLIED 회신을 반복해도 최초 appliedAt·성공 감사를 다시 쓰지 않는다.
- 다른 명시적 publish로 대기가 교체됐거나 applicationId가 다르면 **409 VERSION_CONFLICT**다. 새 통화를 열기 전에 ACTIVE/PENDING을 다시 조회한다. 초안 확정으로 HEAD만 이동한 것은 대기 교체가 아니다.
- v3 publish 요청 후 초안이 v4로 확정돼도 원래 v3·UUID의 적용 회신을 수락한다. AI와 백엔드는 적용 회신 버전을 현재 HEAD와 비교하지 않는다.
- 응답 유실·타임아웃은 적용 실패로 단정하지 않는다. 신규 통화 진입을 보호하면서 같은 회신을 재시도하거나 ACTIVE의 버전·applicationId로 확인한다. 예전 캐시로 통화를 먼저 시작하지 않는다.
- 검증·설치 실패는 `result=FAILED`와 `errorCode=INVALID_CONFIG | UNSUPPORTED_OPTIONS | APPLY_FAILED`로 회신한다. 원문 프롬프트·예외 메시지는 보내지 않는다. 백엔드는 기존 ACTIVE와 PENDING을 보존한다.
- FAILED에는 errorCode가 필수이며 APPLIED에는 보내지 않는다. FAILED의 200·PENDING은 적용 성공을 뜻하지 않는다. 기존 기본 설정으로 복구하지 못했거나 결과가 불명확하면 신규 통화 진입을 계속 막고 재동기화한다.
- 백엔드 알림 워커는 기존대로 5초마다 확인하고 같은 힌트를 최소 30초 간격으로 재전송한다. 알림 수신은 적용 완료가 아니며 통화 진입 조회를 대체하지 않는다.
- 알림 실패·응답 불명은 applyErrorCode=AI_UNAVAILABLE로 표시하며 같은 applicationId로 다시 알린다. 대기와 마지막 알림 시각을 DB에 보존하므로 백엔드 재시작 후에도 재시도한다. AI 네트워크 호출을 DB 트랜잭션 안에서 기다리지 않는다.

## AI가 제공할 API

| API | 요청·응답 계약 |
| --- | --- |
| GET /internal/persona/options | HTTP 200의 직접 JSON 객체로 실제 지원 옵션을 반환. data로 감싸지 않음 |
| POST /internal/persona/refresh | `{ aiPersonaVersionSeq, applicationId }` 변경 알림을 받고 HTTP 202. 설정 원문이 아닌 힌트이며 중복·역순 수신 가능 |

옵션 응답 예시:

```json
{
  "voices": [{ "id": "실제로-지원하는-음성-ID", "label": "표시명" }],
  "speakingRate": { "min": null, "max": null },
  "turnWaitLevels": ["NORMAL"]
}
```

voiceId·speakingRate의 null은 AI 기본값이다. 숫자 속도는 실제 지원 min~max로, 말끝 대기는 구현한 SHORT/NORMAL/LONG만 제공한다. 속도 조절 미지원이면 min/max를 모두 null로 반환한다. 네트워크 timeout·통화 종료 대기를 말 속도나 말끝 대기 조절로 매핑하지 않는다. 전체 promptText의 실행 프롬프트 주입 대상과 음성·속도·대기 제어는 AI에서 구현하며 저장만 하고 APPLIED로 회신하지 않는다.

AI 재시작 시 ACTIVE/PENDING을 조회해 복구한다. ACTIVE가 없고 PENDING만 있으면 적용 절차부터 완료하며, 둘 다 없으면 설정 미완료로 두고 임의 버전을 선택하지 않는다. 현재 단일 AI 프로세스를 전제로 하며 여러 인스턴스를 운영하려면 기본 버전 전환과 통화 진입을 전체 인스턴스에서 동기화하는 별도 계약이 필요하다.

## 통화 기록과 버전 번호

AI는 통화 시작 때 고정한 `call.persona_version`을 끝까지 유지한다. ANL-01 분석의 `aiPersonaVersionSeq`에도 **해당 통화가 실제 사용한 버전**을 보내야 한다. 통화 종료 시점의 글로벌 ACTIVE를 조회해 기록하면 안 된다.

예를 들어 통화 A가 버전 1로 시작한 뒤 기본 버전이 2로 바뀌어도 A의 분석은 버전 1이다. 새 통화 B는 버전 2다. 백엔드는 INACTIVE가 된 과거 버전도 분석 참조로 허용하며 기존 설정 내용은 덮어쓰지 않는다.

`version`은 페르소나 안의 표시 번호(v1, v2), `aiPersonaVersionSeq`는 DB 식별자다. 서로 대체해 보내지 않는다.

## 관리자 수정·저장 동작

- 새 페르소나는 전체 설정의 v1·INACTIVE로 저장한다.
- PATCH는 `expectedVersion`·`expectedDraftRevision`을 확인하고 유형별 초안 한 개를 생성·덮어쓴다. 초안 저장은 HEAD·버전 이력·실제 상담·publish 대기를 바꾸지 않는다.
- POST `/api/personas/{id}/versions`가 확인한 초안을 vN+1 전체 설정으로 확정하고 초안을 삭제한다. 같은 내용이면 버전 추가 없이 초안만 삭제한다. 오래된 HEAD·초안 식별값은 409 VERSION_CONFLICT다.
- **초안 확정이 새 INACTIVE 버전을 해당 유형의 HEAD로 만든다.** 실제 통화 설정과 publish 대기는 변경하지 않는다. 프론트 요청·응답 전환은 [관리 계약](persona-head-management.md)을 따른다.
- POST `/api/personas/{id}/activate`로 확인한 최신 HEAD를 publish한다. 같은 유형의 새 HEAD도 다시 publish할 수 있으며 수동 HEAD 변경과 과거 버전 재발행은 제공하지 않는다.

## AI 팀 확인 항목

1. 통화 A 진행 중 적용 요청 → A는 기존 프롬프트·음성·버전 유지.
2. 다른 통화가 계속 진행 중이어도 다음 통화 B는 새 버전으로 시작.
3. 5초 알림이 아직 도착하지 않은 시점의 신규 통화도 최신 PENDING을 확인.
4. 두 번의 적용 요청·동시 통화 진입에서 오래된 버전이 새 기본값을 덮어쓰지 않음.
5. 회신 유실·409·AI 재시작에서 설정과 백엔드 ACTIVE를 재동기화.
6. A·B 종료 분석이 각자의 시작 버전을 참조.

백엔드 테스트는 비제로 활성 통화 수 회신, 기존 버전 이력 보존, 중복·오래된 회신과 감사 실패 롤백을 검증한다. 기존 통화의 실제 음성이 유지되고 다음 통화가 새 음성으로 시작하는지는 **AI 변경·배포 후 실제 연동 검증**이 필요하다.
