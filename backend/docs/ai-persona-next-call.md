# AI 팀 전달: 페르소나를 다음 통화부터 적용

2026-11-01 백엔드 변경 계약이다. 기존 `docs/api/ai-persona-integration.md`의 **통화 0건까지 기다린다**는 조건을 이 문서로 대체한다. AI URL·인증·요청 필드는 유지한다. 관리자 유형별 HEAD·대표 선택은 [최신 관리 계약](persona-head-management.md)을 따른다. 이 작업은 백엔드와 전달 명세까지이며 AI 코드·실제 서버 배포는 포함하지 않는다.

## 원하는 동작

| 시점 | 통화 A | 새로 시작하는 통화 B |
| --- | --- | --- |
| 버전 1 사용 중 | 버전 1로 진행 | 버전 1 사용 |
| 관리자가 버전 2 적용 요청 | 버전 1 유지 | 통화 진입 시 대기 설정을 먼저 동기화 |
| AI가 버전 2 전환을 확인 | 버전 1로 끝까지 진행 | 버전 2로 시작 |

`ACTIVE`는 **새 통화에 사용할 기본 버전**이다. 이미 진행 중인 모든 통화가 같은 버전을 쓴다는 뜻이 아니다. `PENDING`은 AI 확인 전 대기 버전이며 알림 수신·HTTP 202만으로 적용 완료가 아니다. 적용 요청 커밋 이후 시작하는 통화가 새 버전을 사용하도록, 통화 시작 시점에도 설정을 확인해야 한다.

## 현재 AI 코드에서 바꿀 부분

원격 `develop-ai` 확인 기준:

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

AI 서비스 Bearer 인증은 기존 `AI_PERSONA_TOKEN`을 그대로 사용한다. 관리자 publish는 `POST /api/personas/{id}/activate`로 확인한 최신 HEAD를 선택한다. 저장으로 HEAD가 이동해도 실제 상담 버전과 이미 수락한 PENDING·UUID는 바뀌지 않는다. AI는 편집 HEAD가 아닌 설정 조회의 ACTIVE/PENDING을 따른다.

| API | 의미 |
| --- | --- |
| GET /api/ai/config?status=ACTIVE | 신규 통화의 현재 기본 설정. 없으면 404 |
| GET /api/ai/config?status=PENDING | 적용 대기 전체 설정과 applicationId. 없으면 404 |
| POST /api/ai/config/apply-result | 준비한 신규 통화 기본 설정의 적용·실패 회신 |

```json
{
  "aiPersonaVersionSeq": 23,
  "applicationId": "50ee1b2f-8dd2-4b9c-8a19-c7bc193ee15b",
  "result": "APPLIED",
  "activeCallCount": 2
}
```

현재 통화가 2건이어도 위 요청을 허용한다. activeCallCount는 실제 현재 수를 보내며 0 이상의 정수다. 성공 응답의 `data.status`는 ACTIVE이고 `data.aiPersonaVersionSeq`·`applicationId`가 같은 요청인지 확인한다. 기존 URL·필수 필드는 추가하거나 제거하지 않았다.

- 동일 APPLIED 회신을 반복해도 최초 appliedAt·성공 감사를 다시 쓰지 않는다.
- 다른 명시적 publish로 대기가 교체됐거나 applicationId가 다르면 **409 VERSION_CONFLICT**다. 새 통화를 열기 전에 ACTIVE/PENDING을 다시 조회한다. 저장으로 HEAD만 이동한 것은 대기 교체가 아니다.
- v3 publish 요청 후 v4가 저장돼도 원래 v3·UUID의 적용 회신을 수락한다. AI와 백엔드는 적용 회신 버전을 현재 HEAD와 비교하지 않는다.
- 응답 유실·타임아웃은 적용 실패로 단정하지 않는다. 신규 통화 진입을 보호하면서 같은 회신을 재시도하거나 ACTIVE의 버전·applicationId로 확인한다. 예전 캐시로 통화를 먼저 시작하지 않는다.
- 검증·설치 실패는 `result=FAILED`와 `errorCode=INVALID_CONFIG | UNSUPPORTED_OPTIONS | APPLY_FAILED`로 회신한다. 원문 프롬프트·예외 메시지는 보내지 않는다. 백엔드는 기존 ACTIVE와 PENDING을 보존한다.
- 백엔드 알림 워커는 기존대로 5초마다 확인하고 같은 힌트를 최소 30초 간격으로 재전송한다. 알림 수신은 적용 완료가 아니며 통화 진입 조회를 대체하지 않는다.

## 통화 기록과 버전 번호

AI는 통화 시작 때 고정한 `call.persona_version`을 끝까지 유지한다. ANL-01 분석의 `aiPersonaVersionSeq`에도 **해당 통화가 실제 사용한 버전**을 보내야 한다. 통화 종료 시점의 글로벌 ACTIVE를 조회해 기록하면 안 된다.

예를 들어 통화 A가 버전 1로 시작한 뒤 기본 버전이 2로 바뀌어도 A의 분석은 버전 1이다. 새 통화 B는 버전 2다. 백엔드는 INACTIVE가 된 과거 버전도 분석 참조로 허용하며 기존 설정 내용은 덮어쓰지 않는다.

`version`은 페르소나 안의 표시 번호(v1, v2), `aiPersonaVersionSeq`는 DB 식별자다. 서로 대체해 보내지 않는다.

## 관리자 수정·저장 동작

- 새 페르소나는 전체 설정의 v1·INACTIVE로 저장한다.
- PATCH는 최신 `expectedVersion`을 확인하고 변경한 값과 기존 생략값을 합쳐 vN+1 전체 설정을 추가한다. 이전 버전의 내용은 유지한다.
- 동일값 저장은 버전을 늘리지 않는다. 최신 버전과 다르면 409 VERSION_CONFLICT다.
- **수정 저장은 새 INACTIVE 버전을 추가하고 그 유형의 HEAD를 이동한다.** 실제 통화 설정과 publish 대기는 변경하지 않는다.
- POST `/api/personas/{id}/activate`로 확인한 최신 HEAD를 publish한다. 같은 유형의 새 HEAD도 다시 publish할 수 있으며 수동 HEAD 변경과 과거 버전 재발행은 제공하지 않는다.

## AI 팀 확인 항목

1. 통화 A 진행 중 적용 요청 → A는 기존 프롬프트·음성·버전 유지.
2. 다른 통화가 계속 진행 중이어도 다음 통화 B는 새 버전으로 시작.
3. 5초 알림이 아직 도착하지 않은 시점의 신규 통화도 최신 PENDING을 확인.
4. 두 번의 적용 요청·동시 통화 진입에서 오래된 버전이 새 기본값을 덮어쓰지 않음.
5. 회신 유실·409·AI 재시작에서 설정과 백엔드 ACTIVE를 재동기화.
6. A·B 종료 분석이 각자의 시작 버전을 참조.

백엔드 테스트는 비제로 활성 통화 수 회신, 기존 버전 이력 보존, 중복·오래된 회신과 감사 실패 롤백을 검증한다. 기존 통화의 실제 음성이 유지되고 다음 통화가 새 음성으로 시작하는지는 **AI 변경·배포 후 실제 연동 검증**이 필요하다.
