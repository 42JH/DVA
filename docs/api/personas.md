# 페르소나 설정·버전·적용 API

관련 작업: [94](https://ssafy.atlassian.net/browse/S15P31D109-94), [98](https://ssafy.atlassian.net/browse/S15P31D109-98).
백엔드 기준 경로는 `/api`. 관리자 API는 `SYSTEM_ADMIN` 세션, 변경 요청은 기존 허용 Origin을 사용한다.
Swagger 태그는 `Personas`, `AI Settings`. AI 팀용 계약은 [별도 연동 명세](ai-persona-integration.md)를 따른다.

## 저장·반영 기준

- 페르소나 식별자는 `ai_personas`, 전체 설정 이력은 기존 프롬프트 테이블을 이름 변경한 `ai_persona_versions`에 저장한다. 새 업무 테이블은 없다.
- 이름·전체 프롬프트·음성·속도·말끝 대기를 하나의 불변 버전으로 저장한다. 역할·성격·응대 스타일은 전체 `promptText`에서 편집한다.
- `ACTIVE`: AI 적용 확인 완료. `PENDING`: 반영 대기 또는 반영 오류. `INACTIVE`: 미사용 설정·과거 이력.
- ACTIVE·PENDING은 서비스 전체에서 각각 최대 하나다. DB 부분 UNIQUE 인덱스와 상태 변경 트랜잭션으로 보장한다.
- 새 페르소나는 INACTIVE. 적용 또는 대기 중인 페르소나 수정은 새 버전을 PENDING으로 만든다. 다른 비활성 페르소나의 편집은 자동 적용하지 않는다.
- 새 적용 요청은 기존 대기를 INACTIVE로 바꾸고 교체한다. 이력은 삭제하지 않는다. 현재 ACTIVE를 다시 선택하면 다른 대기는 취소한다.
- 새 버전은 기존 ACTIVE를 즉시 바꾸지 않는다. 통화가 없는 AI가 설정을 설치하고 성공을 회신해야 두 상태를 같은 트랜잭션에서 전환한다.
- AI 알림 전달 성공·HTTP 202는 적용 완료가 아니다. 실패·응답 유실 시 기존 ACTIVE와 PENDING을 유지한다.
- 프롬프트 별도 등록·수정 API와 `isMain`/`isActive` 입력은 없다.

## 관리자 API

단건은 `{ data, meta: { requestId } }`, 목록은 `{ data: [], hasNext, total_count }` 형식이다.

| API | 받는 정보 | 처리·반환 |
|---|---|---|
| GET `/api/personas` | `limit` 기본 20, 1~100 / `offset` 기본 0 | 최신 페르소나 번호순 목록. 각 항목에 `aiPersonaSeq`, `code`, `latestVersion`, `activeVersionSeq`, `pendingVersionSeq` |
| POST `/api/personas` | `code`, `name`, `promptText` 필수. `voiceId`, `speakingRate`, `turnWaitLevel` 선택 | AI 지원 옵션을 확인하고 버전 1·INACTIVE 생성. 201, 전체 버전 반환. 고유 코드 중복 409 |
| GET `/api/personas/{id}` | 페르소나 번호 | 최신 전체 설정과 적용·대기 버전 번호. 없는 페르소나 404 |
| PATCH `/api/personas/{id}` | `expectedVersion` 필수 + 변경할 설정 | 생략값 유지, 전체 새 버전 추가. 동일값은 기존 버전 반환. 오래된 버전 409, 변경값 없음 400. 적용·대기 중이면 새 버전을 PENDING으로 교체 |
| GET `/api/personas/{id}/versions` | 페르소나 번호, `limit`/`offset` | 전체 설정 이력을 버전 내림차순으로 반환. 각 버전의 상태·작성자·적용 요청자·시각·오류 포함 |
| POST `/api/personas/{id}/activate` | `aiPersonaVersionSeq`, `expectedVersion` | 해당 페르소나의 버전을 적용 대기로 지정. 202·PENDING 반환. 이미 ACTIVE이면 다른 대기를 취소하고 200 반환 |
| GET `/api/ai/options` | 본문 없음 | 연결된 AI의 `voices`, `speakingRate: { min, max }`, `turnWaitLevels` 반환. 연결 실패·잘못된 응답은 503 |
| GET `/api/ai/config` | `status=ACTIVE` 기본 / `PENDING` 선택 | 서비스 전체의 해당 상태 버전 한 개. 없으면 404. 최상위 관리자 세션 또는 AI 서비스 Bearer 허용 |

`code`는 고유하며 수정하지 않는다. `name`·`promptText`는 공백만인 값을 거절하고 원문을 보존한다.
`voiceId`·`speakingRate`의 null은 AI 기본값을 뜻한다. PATCH에서 생략하면 유지, null은 기본값으로 변경이다.
`turnWaitLevel`은 SHORT/NORMAL/LONG 중 **AI 지원 목록에 포함된 값**만 허용하며 생성 기본값은 NORMAL이다.
속도 min·max가 모두 null이면 숫자 속도는 저장하지 않는다. 실제 지원 범위·음성 목록을 백엔드가 추정하지 않는다.

### 등록 예시

```json
{
  "code": "parcel",
  "name": "택배 상담원",
  "promptText": "차분한 한국어로 택배 접수를 안내합니다.",
  "voiceId": null,
  "speakingRate": null,
  "turnWaitLevel": "NORMAL"
}
```

### 수정·적용 예시

```json
{ "expectedVersion": 1, "name": "친절한 상담원", "promptText": "수정한 전체 원문" }
```

```json
{ "aiPersonaVersionSeq": 7, "expectedVersion": 2 }
```

`expectedVersion`은 **최신 저장 버전 번호**, `aiPersonaVersionSeq`는 **선택한 버전의 DB 식별자**다.
이전 버전 선택으로 이름·프롬프트·음성·속도·대기를 함께 복원한다. 버전 번호를 다시 매기거나 이력을 삭제하지 않는다.
따라서 2번을 복원해도 최신 저장 버전이 5번일 수 있으며 이후 PATCH는 `latestVersion`을 기준으로 수정한다.
과거 전체 설정에서 편집을 시작하려면 선택한 버전의 설정을 PATCH 본문에 모두 포함한다.

## 적용 결과와 감사

AI 전용 POST `/api/ai/config/apply-result`는 [AI 명세](ai-persona-integration.md)의 서비스 토큰·통화 진입 잠금 계약을 따른다. 관리자 세션만으로는 호출할 수 없다.

각 버전은 `applicationId`, `requestedByAdminUserSeq`, `requestedAt`, `appliedAt`, `lastNotifiedAt`, `applyErrorCode`를 반환한다.
적용 요청·대기 교체/취소·성공·실패는 기존 감사 로그에 버전 번호를 대상으로 기록한다. 본문·토큰은 감사에 저장하지 않는다.
관리자 요청은 ADMIN과 당시 이름, 서비스 토큰을 확인한 AI 적용 회신은 AI로 기록한다. 회신 자체의 인증·입력·처리 오류는 PERSONA_APPLY_RESULT로 남긴다.
버전 행의 요청 메타데이터는 최신 적용 요청 기준이며 과거 적용 요청자·시각·결과는 감사 로그에서 조회한다.

- `AI_UNAVAILABLE`: 알림 실패 또는 응답 불명. 같은 applicationId로 다시 알린다.
- `INVALID_CONFIG`, `UNSUPPORTED_OPTIONS`, `APPLY_FAILED`: AI가 보고한 반영 실패. 기존 ACTIVE 유지.
- 실패 대기를 다시 적용 요청하면 새 applicationId를 발급한다. 예전 회신은 409.
- 같은 성공 회신은 기존 ACTIVE를 반환하며 적용 시각·감사를 중복 기록하지 않는다.

백엔드는 5초마다 대기를 확인하고 동일 요청 알림은 최소 30초 간격으로 재시도한다. DB에 대기와 마지막 시도가 남으므로 프로세스 재시작 후 이어서 처리한다.
DB 트랜잭션 안에서 AI 응답을 기다리지 않는다. 새 테이블·별도 큐·범용 멱등키 저장소는 추가하지 않는다.

## 배포·검증 범위

1. 기존 `ai_personas`·`ai_prompt_versions` 데이터 유무를 확인한다. 013은 두 테이블이 비어 있을 때만 전환한다. 데이터가 있다면 당시 음성 설정을 복원할 수 없으므로 임의 변환 없이 중단한다.
2. 기존 runner로 `013-ai-persona-versions.sql`을 적용하고 백엔드를 배포한다. 이미 적용된 SQL은 수정하지 않는다.
3. backend와 AI에 같은 무작위 `AI_PERSONA_TOKEN`을 비밀 환경변수로 주입한다. backend Compose가 이 변수를 전달하며 컨테이너 재생성이 필요하다.
4. AI가 옵션·알림·통화 게이트·결과 회신을 구현한 후 설정을 등록하고 적용한다.

**AI 옵션 API가 없거나 토큰이 없으면 등록·수정·적용은 503이다. 조회는 기존 데이터를 반환한다.**
이번 작업은 백엔드·Swagger·DBML·연동 명세까지다. `ai/` 코드, 실제 AI 엔진, 운영 DB·환경 파일은 변경하지 않는다.
가짜 AI와 격리 PostgreSQL의 동시 요청·권한·재시작·실패 복구 및 실제 Nginx 전달을 검증한다. 실제 통화 중 적용은 AI 구현 후 별도로 검증한다.


모든 목록 응답의 최상위 total_count는 필수인 0 이상 정수이며 같은 검색·필터·권한 범위의 전체 결과 수다. limit·offset 적용 전 COUNT(*)를 목록 데이터와 같은 SQL 스냅샷에서 계산한다. 검색 결과 없음은 0이며 offset이 전체 건수를 넘어 data가 비어도 total_count는 유지한다. 기존 hasNext는 유지한다.
