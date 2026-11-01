# 페르소나 유형별 HEAD와 publish

2026-11-01 초안 도입 계약. 수정 PATCH는 이제 정식 버전 대신 초안을 반환한다. 프론트는 아래의 초안 저장·HEAD 확정 호출로 전환해야 한다. AI 통화 제어는 [다음 통화 적용 명세](ai-persona-next-call.md)를 따른다.

## 관리 규칙

- 유형은 aiPersonaSeq로 구분한다. 버전 번호는 그 유형 안에서만 v1, v2, v3 순서로 증가한다.
- **HEAD는 해당 유형의 최신 확정 버전**이다. 생성하면 v1이 HEAD이고, 초안을 확정해야 새 버전이 HEAD가 된다. HEAD와 같은 내용의 초안을 확정하면 버전 추가 없이 초안만 삭제한다.
- **초안은 유형마다 최대 1개**이며 관리자들이 공유한다. 최초에는 현재 HEAD를 복사하고, 이후 PATCH는 같은 초안의 내용을 덮어쓴다. 임시 저장마다 버전 번호나 초안 이력을 추가하지 않는다.
- 수정 기준은 현재 HEAD다. 과거 HEAD 번호 또는 오래된 초안 수정 식별값으로 PATCH하면 409다. 생략한 설정은 현재 초안에서, 초안이 처음이면 HEAD에서 유지한다.
- **상담 페르소나는 별도로 publish한 특정 버전**이다. 초안 저장·HEAD 확정 모두 기존 ACTIVE와 PENDING을 유지한다.
- 사용자가 publish할 때만, 그 시점에 확인한 HEAD를 통화 적용 대상으로 고정한다. 같은 유형의 새 HEAD도 다시 publish할 수 있다.
- 과거 버전을 새로 publish하거나 HEAD를 뒤로 이동시키는 기능은 제공하지 않는다. 과거 통화와 기존 publish가 참조하는 버전은 유지한다.

| 동작 | 친절형 HEAD | 빠른형 HEAD | 실제 상담 |
| --- | --- | --- | --- |
| 시작 | v3 | v2 | 빠른형 v2 |
| 친절형 초안 저장 반복 | v3 | v2 | 빠른형 v2 |
| 친절형 초안을 HEAD로 확정 | v4 | v2 | 빠른형 v2 |
| 빠른형 초안을 HEAD로 확정 | v4 | v3 | 빠른형 v2 |
| 친절형 publish 성공 | v4 | v3 | 친절형 v4 |
| 빠른형 publish 성공 | v4 | v3 | 빠른형 v3 |

## 관리자 API

목록·상세·버전 이력 조회는 ACTIVE 상태의 OPERATOR·SUPERVISOR·SYSTEM_ADMIN 세션으로 접근할 수 있다. 생성·수정·publish와 AI 지원 옵션 조회는 ACTIVE인 SUPERVISOR(개발자)·SYSTEM_ADMIN에게 허용하며 변경 요청에는 허용 Origin이 필요하다. 역할 코드 추가·변경은 없다. AI 토큰만으로 관리자 조회·편집·publish를 할 수 없다.

| 동작 | API | 결과 |
| --- | --- | --- |
| 유형 생성 | POST /api/personas | v1 INACTIVE 생성, HEAD=v1. 실제 상담 적용은 하지 않음 |
| 초안 저장 | PATCH /api/personas/{id} | 유형별 초안 한 개를 생성·덮어쓰기. HEAD·상담·대기 유지, HTTP 200 |
| HEAD 확정 | POST /api/personas/{id}/versions | 확인한 초안을 새 INACTIVE 버전으로 확정하고 초안 삭제. HTTP 200 |
| publish | POST /api/personas/{id}/activate | 확인한 최신 HEAD의 적용 대기 요청. 202 PENDING, 이미 동일 버전 ACTIVE이면 200 |
| 목록·상세 | GET /api/personas, GET /api/personas/{id} | 최신 HEAD, 실제 상담 버전, publish 대기·오류를 분리해 반환 |
| 버전 이력 | GET /api/personas/{id}/versions | 기존 버전 내림차순 이력 유지 |
| AI 지원 옵션 | GET /api/ai/options | voices, speakingRate의 min/max, turnWaitLevels. AI 연결 실패·잘못된 응답은 503 |

기존 PUT /api/personas/{id}/head는 제거했으며 404다. 프론트는 저장 후 이 API를 호출하지 않는다.

### 생성·수정 입력

생성에는 code, name, promptText가 필수다. code는 고유하며 수정할 수 없고 중복은 409다. name·promptText는 공백만인 값을 거절하고 원문을 보존한다.

```json
{
  "code": "parcel",
  "name": "친절형",
  "promptText": "차분한 한국어로 택배 접수를 안내합니다.",
  "voiceId": null,
  "speakingRate": null,
  "turnWaitLevel": "NORMAL"
}
```

수정에는 expectedVersion, expectedDraftRevision과 변경할 설정을 보낸다. expectedVersion은 확인한 headVersion.version이다. expectedDraftRevision은 초안이 없으면 null, 있으면 조회한 draft.draftRevision(UUID)이며 생략할 수 없다. 설정을 하나도 보내지 않은 PATCH는 400이다. 생략한 설정은 기존 초안 또는 최초 HEAD에서 유지한다. voiceId·speakingRate의 null은 AI 기본값이다. turnWaitLevel은 SHORT/NORMAL/LONG 중 실제 AI 지원 목록의 값만 허용하며 생성 기본값은 NORMAL이다. 속도 min/max가 모두 null이면 숫자 속도를 지원하지 않는다. AI 옵션 API 미연결·토큰 미설정 시 생성·초안 저장·확정·publish는 503이며 조회는 기존 데이터를 반환한다.

```json
{ "expectedVersion": 4, "expectedDraftRevision": null, "name": "작성 중 친절형", "promptText": "중간 저장 원문" }
```

### 프론트의 초안 저장과 HEAD 확정

1. GET /api/personas/{id}에서 headVersion과 draft를 읽는다. draft가 있으면 그 내용으로 편집을 이어가고, 없으면 HEAD로 편집을 시작한다.
2. 임시 저장 버튼은 PATCH /api/personas/{id}를 호출한다. 응답 data는 아래의 초안 객체이며 version·aiPersonaVersionSeq·status는 없다. 최신 draftRevision을 편집 화면에 보관한다.
3. 추가 임시 저장에는 같은 expectedVersion과 방금 받은 draftRevision을 expectedDraftRevision으로 보낸다. 다른 관리자가 저장했으면 409 VERSION_CONFLICT다. 서버 내용을 다시 조회하고 사용자가 작성한 내용과 비교하며, 자동으로 최신 식별값만 바꿔 덮어쓰지 않는다.
4. HEAD로 설정 버튼은 POST /api/personas/{id}/versions를 호출한다. 편집 후 아직 임시 저장하지 않은 내용이 있으면 먼저 PATCH를 완료하고 그 응답의 식별값으로 확정한다. 확정 API에는 설정 본문을 보내지 않는다.
5. 확정 성공 응답 data는 기존 PersonaVersionDto다. 내용이 바뀌었다면 v5 INACTIVE가 생성되고, 상세의 headVersion/latestVersion은 v5, draft는 null이다. 내용이 HEAD와 같으면 HEAD를 그대로 반환하고 초안만 삭제한다.
6. 실제 상담에 쓰려면 확정한 HEAD로 기존 activate를 별도 호출한다.

PATCH 응답 예시(HTTP 200):

```json
{
  "data": {
    "aiPersonaSeq": 1,
    "draftRevision": "00000000-0000-4000-8000-000000000039",
    "baseVersion": 4,
    "name": "작성 중 친절형",
    "promptText": "중간 저장 원문",
    "voiceId": null,
    "speakingRate": null,
    "turnWaitLevel": "NORMAL",
    "updatedByAdminUserSeq": 7,
    "createdAt": "2026-11-01T22:00:00.000+09:00",
    "updatedAt": "2026-11-01T22:00:00.000+09:00"
  },
  "meta": { "requestId": "00000000-0000-4000-8000-000000000040" }
}
```

추가 수정 저장 본문:

```json
{
  "expectedVersion": 4,
  "expectedDraftRevision": "00000000-0000-4000-8000-000000000039",
  "promptText": "추가 개발한 전체 원문"
}
```

변경 저장마다 draftRevision은 새 UUID로 바뀐다. 같은 내용을 다시 저장하면 식별값과 시각을 유지한다. 이 값은 인증 토큰·환경변수가 아니며 초안 충돌 검사용이다. createdAt은 최초 초안 생성 시각을 유지하고 updatedAt·updatedByAdminUserSeq는 실제 변경 저장 시 갱신한다. 관리자 번호는 물리 삭제 후에도 유지하는 논리 참조다.

초안 내용의 중간 스냅샷은 보관하지 않는다. 저장·확정 행위는 기존 감사 정책에 따라 PERSONA_DRAFT_SAVED·PERSONA_DRAFT_COMMITTED로 남기되 프롬프트·설정 본문은 감사에 저장하지 않는다. 새 정식 버전의 작성자는 확정 요청을 보낸 관리자다.

HEAD 확정 본문(추가 저장이 있었다면 그 응답의 최신 UUID를 사용):

```json
{
  "expectedVersion": 4,
  "expectedDraftRevision": "00000000-0000-4000-8000-000000000041"
}
```

HEAD·초안 변경 충돌은 409 VERSION_CONFLICT, 초안이 없는 확정은 409 INVALID_STATE다. 이미 확정된 요청을 재전송하면 409이며 버전을 중복 생성하지 않는다. 응답 유실 때는 상세를 재조회해 HEAD·초안 상태를 확인한다. 저장 전에는 조회한 HEAD·초안, 외부 AI 옵션 확인 후에는 잠금 안에서 같은 두 값을 다시 검사한다. 저장 또는 확정 실패 시 기존 초안과 HEAD는 트랜잭션으로 보존한다.

### publish 입력

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

예를 들어 v3을 publish 요청한 뒤 초안을 v4로 확정하면 HEAD=v4, PENDING=v3이다. AI가 원래 applicationId로 v3 적용 성공을 보내면 정상 수락해 ACTIVE=v3으로 전환한다. 현재 HEAD와 다르다는 이유로 회신을 거절하지 않는다.

다른 명시적 publish가 기존 대기를 교체하면 이전 UUID의 회신은 409다. 같은 정상 대기는 UUID를 재사용하고, 여전히 HEAD인 실패 버전을 다시 publish하면 새 UUID를 발급한다. 이미 수락한 요청의 재알림·회신 재시도는 HEAD가 이동해도 같은 UUID로 계속 처리한다.

## 프론트 조회 필드

단건은 기존 data/meta, 목록은 data/hasNext/total_count 형식을 유지한다.
목록의 limit은 기본 20·최대 100, offset은 기본 0이다. total_count는 같은 조회 조건에서 페이지 적용 전 전체 건수다. 버전 이력도 같은 목록 형식을 사용한다.

| 필드 | 의미·화면 연결 |
| --- | --- |
| headVersion | 유형별 최신 확정 전체 설정. 생성부터 항상 객체 |
| latestVersion | 기존 호환 필드. headVersion과 같은 확정 버전·설정 |
| draft | 유형별 작성 중 설정·수정 UUID·기준 HEAD·저장자 번호·시각. 없거나 확정 후에는 null |
| activeVersion | AI 적용을 확인한 실제 상담 전체 설정. 미사용 유형은 null |
| pendingVersion | publish 요청 때 고정한 대기 전체 설정. 없으면 null |
| activeVersionSeq | 기존 호환 필드. activeVersion의 식별자 또는 null |
| pendingVersionSeq | 기존 호환 필드. pendingVersion의 식별자 또는 null |

전체 버전 객체에는 version, aiPersonaVersionSeq, 이름·프롬프트·음성 설정, 작성자 번호·이름, 적용 요청 UUID·시각·오류 등이 포함된다. 작성자 이름은 기존 논리 참조·감사 이력으로 조회한다.
적용 메타데이터는 applicationId, requestedByAdminUserSeq, requestedAt, appliedAt, lastNotifiedAt, applyErrorCode다. 버전 행에는 최신 요청을 표시하고 과거 요청·대기 교체·취소·성공·실패는 감사 기록으로 보존한다. 토큰·프롬프트 본문은 감사에 저장하지 않는다.

화면에서는 **확정 HEAD v4 / 초안 작성 중 / 상담 적용 v2 / 반영 대기 v3**을 구분해 보여준다. HEAD의 status가 INACTIVE여도 실제 상담은 activeVersion으로 계속 진행할 수 있다. HEAD와 ACTIVE가 다른 것은 정상 상태다.

- 임시 저장 버튼: expectedVersion·expectedDraftRevision과 변경 설정으로 PATCH한다. 초안 객체를 편집 상태에 반영하며 HEAD나 상담 반영 완료로 표시하지 않는다.
- HEAD로 설정 버튼: 먼저 화면의 변경을 초안에 저장하고, 그 최신 식별값으로 POST versions를 호출한다. 성공하면 새 HEAD를 표시하고 초안 편집 상태를 비운다.
- 과거 버전: 이력 조회만 제공하고 수정 시작 버튼을 제공하지 않는다.
- publish 버튼: 같은 유형을 사용 중이어도 headVersion과 activeVersion 식별자가 다르면 새 HEAD를 요청할 수 있어야 한다.
- 반영 대기: pendingVersion이 있고 applyErrorCode가 null인 상태다. HTTP 202는 실제 적용 완료가 아니다.
- 반영 실패: pendingVersion.applyErrorCode를 표시한다. 실패해도 activeVersion과 기존 상담은 유지된다. 실패한 버전보다 새 HEAD가 있으면 확인한 새 HEAD를 publish한다.
- 반영 완료: activeVersion이 요청한 버전으로 바뀌었는지 확인한다. 그동안 저장된 최신 HEAD가 더 앞서 있을 수 있다.

ACTIVE/PENDING/INACTIVE는 정식 버전의 통화 적용 상태로 유지한다. 작성 중 표시는 draft가 있는지로 판단하며 AI 적용 상태에 DRAFT 값을 추가하지 않는다.
latestVersion과 식별자 호환 필드는 현재 프론트 연동을 위해 유지한다. 소비자 전환을 확인하기 전에는 제거하지 않는다.

## DB 전환과 검증

기존 migration 034·035는 수정하지 않는다. 036-remove-redundant-persona-head.sql은 조회에 사용하지 않는 head_version_seq 복사 컬럼만 제거한다. HEAD는 기존 유형별 버전 고유 인덱스와 최신 버전 조회로 구한다. ACTIVE/PENDING 버전, UUID, 설정 이력, 감사, 통화 참조는 변경하지 않는다. 의존 객체가 있으면 CASCADE로 삭제하지 않고 migration을 중단한다.

039-persona-drafts.sql은 ai_persona_drafts를 추가한다. ai_persona_seq 기본키로 유형별 한 개를 보장하며 번호는 논리 참조다. 기존 유형·확정 버전·상담·적용 대기 데이터는 변경하지 않는다. 배포 DB 검증은 039 기록, 초안 기본키·UUID·기준 버전 구조와 전체 29개 테이블을 확인한다.

신규 생성과 초안 저장·확정은 각각 감사와 같은 트랜잭션에서 처리한다. 확정에서는 새 버전 추가·초안 삭제·감사가 모두 커밋되거나 모두 롤백된다. 외부 AI 옵션 HTTP를 기다리는 동안 DB 트랜잭션·잠금을 유지하지 않는다. 별도의 HEAD 갱신 쿼리는 없다. publish는 잠금 안에서 확인한 최신 확정 버전 객체를 재사용한다.

배포 전 039까지 적용하고 모든 이전 앱을 종료한 뒤 프론트와 PATCH 계약을 함께 전환한다. 기존 PATCH 입력은 expectedDraftRevision 누락으로 400이며 저장 응답을 정식 버전으로 처리하면 안 된다. 이전 앱은 초안을 모른 채 HEAD를 변경할 수 있으므로 신·구 앱을 동시에 운영하지 않는다. 실제 서버 DB 적용·배포는 별도다.

036에서 제거한 head_version_seq를 쓰는 과거 앱은 해당 컬럼 없이 버전을 저장할 수 없다. 이 컬럼을 사용하는 구버전으로 복구하려면 먼저 양수 정수 컬럼을 복원하고 035의 최신 버전 채우기를 실행해야 한다. 이번 초안 기능의 새 앱에는 039까지 필요하며 실제 서버 적용 전 외부 SQL 의존성도 확인한다.

AI 설정 조회·회신의 URL·인증은 유지한다. activeCallCount는 생략 가능한 호환 필드로 남기며 적용 판단에는 사용하지 않는다. 적용 회신은 원래 PENDING과 UUID를 검사하며 현재 HEAD와 비교하지 않는다. 실제 서버 DB 적용·프론트 수정·AI 코드 변경·배포는 이 작업에 포함하지 않는다.
