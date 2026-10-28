# AI 팀 전달용: 페르소나 설정 연동

백엔드 94·98 계약. **AI 코드에는 아직 반영하지 않았다.** 기존 주문·고객·PBX API 계약은 그대로다.
현재 확인한 AI 코드는 통화 시작 시 로컬 설정·프롬프트를 읽는다. 아래 내부 API와 통화 게이트는 AI 팀 구현 항목이다.

## 인증과 경로

- 양방향 `Authorization: Bearer <AI_PERSONA_TOKEN>`. 32자 이상 무작위 ASCII 토큰을 비밀 환경변수로 공유한다. 토큰·프롬프트 본문은 로그에 남기지 않는다.
- AI → BE 기준 `/api`, BE → AI 기준 `AI_AGENT_URL` + `/internal`. `/v1`은 붙이지 않는다.
- AI 요청에는 관리자 쿠키·Origin을 넣지 않는다. 이 서비스 토큰은 페르소나 설정 연동 전용이며 주문·관리자 권한을 주지 않는다.

| 방향 | API | 계약 |
|---|---|---|
| BE → AI | GET `/internal/persona/options` | 아래 지원 옵션을 HTTP 200의 **직접 JSON 객체**로 반환 |
| BE → AI | POST `/internal/persona/refresh` | `{ aiPersonaVersionSeq, applicationId }` 알림. 접수 시 **202**. 프롬프트가 아닌 변경 힌트이며 중복·역순 수신 가능 |
| AI → BE | GET `/api/ai/config` | 현재 ACTIVE 한 개. `{ data, meta }`. 없으면 404 |
| AI → BE | GET `/api/ai/config?status=PENDING` | 최신 PENDING 한 개. `{ data, meta }`. 없으면 404 |
| AI → BE | POST `/api/ai/config/apply-result` | 실제 적용 성공·실패 회신. 아래 예시. `{ data, meta }`의 status로 결과 확인 |

옵션 응답 예시(미지원 속도를 지원한다고 표시하지 않는다):

```json
{
  "voices": [{ "id": "실제로-지원하는-음성-ID", "label": "표시명" }],
  "speakingRate": { "min": null, "max": null },
  "turnWaitLevels": ["NORMAL"]
}
```

`voiceId:null`·`speakingRate:null`은 AI 기본값이다. 숫자 속도는 실제 지원 min~max로, 말끝 대기는 구현한 SHORT/NORMAL/LONG만 제공한다.
단순 네트워크 timeout·통화 종료 대기를 말 속도나 말끝 대기 조절로 매핑하지 않는다. 현재 AI 문서는 해당 직접 제어를 지원하지 않는다고 명시하므로 실제 구현·확인 전에는 범위를 넓히지 않는다.
관리자는 전체 `promptText`를 수정한다. 현재 분리된 음성용·업무용 실행 프롬프트 중 주입 대상과 실제 속도·대기 제어 방식은 AI 팀에서 확정·구현해야 한다. 저장만 하고 적용 성공으로 회신하지 않는다.

## 통화 없는 시점의 적용 순서

1. 알림을 받거나 AI가 재시작하면 BE의 ACTIVE/PENDING을 조회한다. 알림에 온 버전만 믿지 않고 **현재 PENDING**을 가져온다.
2. 진행 중 통화가 있으면 기존 ACTIVE를 계속 사용하고 적용을 기다린다. PBX 웹훅 도착 여부가 아니라 **AI의 실제 통화 레지스트리**를 사용한다.
3. 통화가 0건이 되면 **신규 통화 진입을 잠그고**, PENDING을 다시 조회하여 검증·컴파일한 전체 설정을 설치한다.
4. 잠금을 유지한 채 같은 버전 번호·applicationId로 APPLIED를 회신한다. BE는 현재 대기 요청인지 확인한 뒤 기존 ACTIVE→INACTIVE, PENDING→ACTIVE를 한 트랜잭션으로 처리한다.
5. 응답이 ACTIVE이고 버전·applicationId가 실제 설치한 설정과 일치하는 것을 확인한 뒤 신규 통화를 허용한다. 진행 중 통화의 설정은 교체하지 않는다.

```json
{
  "aiPersonaVersionSeq": 7,
  "applicationId": "49c3a28a-d55e-4685-8242-4c98625f4e10",
  "result": "APPLIED",
  "activeCallCount": 0
}
```

예시 번호·UUID를 고정하지 말고 PENDING 응답의 실제 값을 사용한다.

실패 시 `result:"FAILED"`, `errorCode:"INVALID_CONFIG" | "UNSUPPORTED_OPTIONS" | "APPLY_FAILED"`를 추가한다. APPLIED에는 errorCode를 보내지 않는다.
FAILED 회신은 200·PENDING을 반환하며 이전 ACTIVE를 유지한다. AI는 이전 설정을 복원한 상태여야 하며 복원 여부도 불명확하면 통화 진입 잠금을 유지한다.

## 교체·재시도·응답 유실

- 설정 버전 식별자는 `aiPersonaVersionSeq`, 적용 시도 식별자는 `applicationId`다. 같은 버전을 나중에 다시 적용하면 applicationId가 달라질 수 있다.
- 관리자 수정·다른 페르소나 선택으로 PENDING이 교체되면 옛 결과는 **409 VERSION_CONFLICT**다. AI는 새 통화를 열기 전에 ACTIVE/PENDING을 다시 조회해 실제 설정을 맞춘다.
- 결과 회신 timeout은 적용 실패를 의미하지 않는다. 잠금을 유지하고 같은 회신을 재시도하거나 ACTIVE를 조회한다. ACTIVE가 같은 applicationId면 완료된 것이다.
- 다른 ACTIVE가 확인되면 그 설정을 복원하거나 최신 PENDING을 처리한다. 확인 없이 옛 설정으로 통화 진입을 열지 않는다.
- 같은 APPLIED 회신은 반복 가능하다. BE는 최초 적용 시각·감사를 다시 쓰지 않는다.
- BE는 전송 실패 후에도 PENDING을 보존하고 같은 힌트를 최소 30초 간격으로 다시 알린다. 알림 중복은 AI가 같은 적용 작업으로 처리한다.
- AI 시작 시 ACTIVE가 없고 PENDING만 있다면 먼저 위 적용 절차를 완료한다. 둘 다 없으면 설정 미완료 상태로 두고 임의 페르소나를 선택하지 않는다.

현재 **단일 AI 프로세스/워커**를 전제로 한다. 여러 AI 인스턴스를 운영하려면 모든 인스턴스의 통화 수·신규 통화 진입·설정 전환을 묶는 별도 동기화가 필요하다.

연동 확인: 통화 중 편집 → PENDING 유지 → 마지막 통화 종료 → ACTIVE 전환, 대기 두 번 교체 후 옛 회신 거절, 회신 timeout 후 재동기화, AI 재시작 후 ACTIVE 복원까지 실제 AI 서버에서 검증한다.
