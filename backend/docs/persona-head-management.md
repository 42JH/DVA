# 페르소나 유형별 HEAD와 publish

2026-11-01 최신 계약. 이전의 수동 HEAD 선택 및 버전 적용 API를 이 문서로 대체한다. AI 통화 제어는 [다음 통화 적용 명세](ai-persona-next-call.md)를 따른다.

## 관리 규칙

- 유형은 aiPersonaSeq로 구분한다. 버전 번호는 그 유형 안에서만 v1, v2, v3 순서로 증가한다.
- **HEAD는 항상 해당 유형의 최신 저장 버전**이다. 생성하면 v1이 HEAD이고, 수정 저장하면 새 버전이 HEAD가 된다. 동일값 저장은 버전을 추가하지 않는다.
- 수정 기준은 현재 HEAD다. 과거 버전 번호로 PATCH하면 409이며 이전 버전 내용은 덮어쓰지 않는다.
- **상담 페르소나는 별도로 publish한 특정 버전**이다. 같은 유형을 수정해 HEAD가 이동해도 ACTIVE와 PENDING은 바뀌지 않는다.
- 사용자가 publish할 때만, 그 시점에 확인한 HEAD를 통화 적용 대상으로 고정한다. 같은 유형의 새 HEAD도 다시 publish할 수 있다.
- 과거 버전을 새로 publish하거나 HEAD를 뒤로 이동시키는 기능은 제공하지 않는다. 과거 통화와 기존 publish가 참조하는 버전은 유지한다.

| 동작 | 친절형 HEAD | 빠른형 HEAD | 실제 상담 |
| --- | --- | --- | --- |
| 시작 | v3 | v2 | 빠른형 v2 |
| 친절형 수정 저장 | v4 | v2 | 빠른형 v2 |
| 빠른형 수정 저장 | v4 | v3 | 빠른형 v2 |
| 친절형 publish 성공 | v4 | v3 | 친절형 v4 |
| 빠른형 publish 성공 | v4 | v3 | 빠른형 v3 |

## 관리자 API

모두 기존 SYSTEM_ADMIN 세션과 허용 Origin이 필요하다. AI 토큰으로 편집하거나 publish할 수 없다.

| 동작 | API | 결과 |
| --- | --- | --- |
| 유형 생성 | POST /api/personas | v1 INACTIVE 생성, HEAD=v1. 실제 상담 적용은 하지 않음 |
| 수정 저장 | PATCH /api/personas/{id} | 최신 HEAD를 기준으로 vN+1 INACTIVE 추가, HEAD 이동. publish는 유지 |
| publish | POST /api/personas/{id}/activate | 확인한 최신 HEAD의 적용 대기 요청. 202 PENDING, 이미 동일 버전 ACTIVE이면 200 |
| 목록·상세 | GET /api/personas, GET /api/personas/{id} | 최신 HEAD, 실제 상담 버전, publish 대기·오류를 분리해 반환 |
| 버전 이력 | GET /api/personas/{id}/versions | 기존 버전 내림차순 이력 유지 |

기존 PUT /api/personas/{id}/head는 제거했으며 404다. 프론트는 저장 후 이 API를 호출하지 않는다.

publish 본문:

```json
{
  "aiPersonaVersionSeq": 23,
  "expectedVersion": 6
}
```

- aiPersonaVersionSeq는 사용자가 확인한 headVersion.aiPersonaVersionSeq다. 표시 번호 v6과 DB 식별자 23은 다르다.
- expectedVersion은 확인한 headVersion.version이며 latestVersion.version과도 같다.
- 서버는 같은 잠금 안에서 두 값을 모두 재확인한다. 요청 수락 전에 HEAD가 바뀌었다면 409 VERSION_CONFLICT다. 변경된 유형을 다시 조회하고 확인한다.
- 유형 번호만 보내 서버가 최신 HEAD를 임의 선택하는 동작은 제공하지 않는다.
- **수락 후에는 버전 식별자와 applicationId가 고정된다.** 이후 새 버전 저장은 대기 교체나 취소를 일으키지 않는다.

예를 들어 v3을 publish 요청한 뒤 v4를 저장하면 HEAD=v4, PENDING=v3이다. AI가 원래 applicationId로 v3 적용 성공을 보내면 정상 수락해 ACTIVE=v3으로 전환한다. 현재 HEAD와 다르다는 이유로 회신을 거절하지 않는다.

다른 명시적 publish가 기존 대기를 교체하면 이전 UUID의 회신은 409다. 같은 정상 대기는 UUID를 재사용하고, 여전히 HEAD인 실패 버전을 다시 publish하면 새 UUID를 발급한다. 이미 수락한 요청의 재알림·회신 재시도는 HEAD가 이동해도 같은 UUID로 계속 처리한다.

## 프론트 조회 필드

단건은 기존 data/meta, 목록은 data/hasNext/total_count 형식을 유지한다.

| 필드 | 의미·화면 연결 |
| --- | --- |
| headVersion | 유형별 최신 저장 전체 설정. 생성부터 항상 객체 |
| latestVersion | 기존 호환 필드. headVersion과 같은 버전·설정 |
| activeVersion | AI 적용을 확인한 실제 상담 전체 설정. 미사용 유형은 null |
| pendingVersion | publish 요청 때 고정한 대기 전체 설정. 없으면 null |
| activeVersionSeq | 기존 호환 필드. activeVersion의 식별자 또는 null |
| pendingVersionSeq | 기존 호환 필드. pendingVersion의 식별자 또는 null |

전체 버전 객체에는 version, aiPersonaVersionSeq, 이름·프롬프트·음성 설정, 작성자 번호·이름, 적용 요청 UUID·시각·오류 등이 포함된다. 작성자 이름은 기존 논리 참조·감사 이력으로 조회한다.

화면에서는 **최신 저장 v4 / 상담 적용 v2 / 반영 대기 v3**을 구분해 보여준다. HEAD의 status가 INACTIVE여도 실제 상담은 activeVersion으로 계속 진행할 수 있다. HEAD와 ACTIVE가 다른 것은 정상 상태다.

- 저장 버튼: 현재 HEAD의 내용과 expectedVersion으로 PATCH한다. 저장 성공을 상담 반영 완료로 표시하지 않는다.
- 과거 버전: 이력 조회만 제공하고 수정 시작 버튼을 제공하지 않는다.
- publish 버튼: 같은 유형을 사용 중이어도 headVersion과 activeVersion 식별자가 다르면 새 HEAD를 요청할 수 있어야 한다.
- 반영 대기: pendingVersion이 있고 applyErrorCode가 null인 상태다. HTTP 202는 실제 적용 완료가 아니다.
- 반영 실패: pendingVersion.applyErrorCode를 표시한다. 실패해도 activeVersion과 기존 상담은 유지된다. 실패한 버전보다 새 HEAD가 있으면 확인한 새 HEAD를 publish한다.
- 반영 완료: activeVersion이 요청한 버전으로 바뀌었는지 확인한다. 그동안 저장된 최신 HEAD가 더 앞서 있을 수 있다.

ACTIVE/PENDING/INACTIVE는 통화 적용 상태로 유지한다. 작성 중 상태나 별도의 HEAD 상태 값은 추가하지 않는다.

## DB 전환과 검증

기존 migration 034는 수정하지 않는다. 새 앱 실행 전 035-persona-latest-heads.sql까지 적용한다. 035는 기존 유형의 head_version_seq를 최신 저장 버전으로 맞춘다. ACTIVE/PENDING 버전, UUID, 설정 이력, 감사, 통화 참조는 변경하지 않는다.

신규 생성·수정은 버전 추가와 저장된 HEAD 번호 갱신·감사를 같은 트랜잭션에서 처리한다. 실패하면 함께 복구한다. 조회의 HEAD는 최신 저장 버전으로 계산하고, 실제 상담·대기는 별도 상태에서 조회한다.

AI 설정 조회·회신의 URL·인증·필드는 유지한다. 적용 회신은 원래 PENDING과 UUID를 검사하며 현재 HEAD와 비교하지 않는다. 실제 서버 DB 적용·프론트 수정·AI 코드 변경·배포는 이 작업에 포함하지 않는다.
