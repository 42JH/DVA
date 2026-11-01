# 페르소나 유형·HEAD·대표 관리

2026-11-01 변경 계약. 기존 페르소나 명세의 **수정 저장 시 자동 PENDING**과 **임의 버전을 바로 대표로 적용**하는 동작을 이 문서로 대체한다. AI 통화 제어는 [다음 통화 적용 명세](ai-persona-next-call.md)를 함께 따른다.

## 관리 단위

- 유형: `aiPersonaSeq`로 구분하는 친절형·신속형 등. 유형 사이에 버전을 합치거나 공유하지 않는다.
- 저장 버전: 유형 안에서 v1, v2, v3 순서로 추가하는 전체 설정 이력. 기존 버전 내용은 덮어쓰지 않는다.
- HEAD: 해당 유형에서 마지막으로 **버전 적용**한 설정. 최신 저장 버전보다 이전 버전일 수 있고, 대표에서 제외되어도 유지한다.
- 대표: 실제 새 통화에 사용할 유형. 그 유형의 HEAD 하나만 AI 적용 대상으로 선택한다.

| 유형 | 최신 저장 버전 | HEAD | 실제 통화 적용 |
| --- | --- | --- | --- |
| 친절형 | v4 | v3 | v3 ACTIVE |
| 신속형 | v6 | v5 | 미사용 |
| 공감형 | v1 | 없음 | 미사용 |

신속형의 v6을 버전 적용하면 신속형 HEAD만 v6으로 이동한다. 친절형 v3 통화는 유지한다. 이후 신속형을 대표로 선택하면 AI에 신속형 v6을 반영한다.

## 저장·버전 적용·대표 선택

| 동작 | API | 결과 |
| --- | --- | --- |
| 유형 생성 | POST `/api/personas` | v1 INACTIVE, HEAD 없음. 대표로 자동 선택하지 않음 |
| 수정 저장 | PATCH `/api/personas/{id}` | 그 유형에 새 INACTIVE 버전 추가. HEAD·ACTIVE·PENDING을 변경하지 않음 |
| 버전 적용 | PUT `/api/personas/{id}/head` | 선택한 버전으로 해당 유형의 HEAD 변경. 200 |
| 대표 선택 | POST `/api/personas/{id}/activate` | 현재 HEAD만 통화용으로 요청. 202 PENDING, 이미 ACTIVE이면 200 |

PUT head와 POST activate는 다음 본문을 사용한다. `expectedVersion`은 **HEAD 번호가 아니라 최신 저장 버전 번호**다.

```json
{
  "aiPersonaVersionSeq": 23,
  "expectedVersion": 6
}
```

- `aiPersonaVersionSeq`: 버전의 DB 식별자. 표시 번호 v6과 다르다.
- PUT head: 그 유형에 속한 버전이면 과거 버전도 선택 가능하다. 새 버전을 만들지 않는다.
- POST activate: `headVersion.aiPersonaVersionSeq`를 보낸다. HEAD가 없으면 409 INVALID_STATE, HEAD와 다른 버전이면 409 VERSION_CONFLICT다.
- 최신 저장 버전과 expectedVersion이 다르면 두 API 모두 409 VERSION_CONFLICT다. 같은 유형의 설정을 다시 조회한다.
- 모든 관리자 요청은 기존 SYSTEM_ADMIN 세션과 허용 Origin이 필요하다. AI 토큰으로 HEAD나 대표를 선택할 수 없다.

대표 유형의 HEAD를 변경하면 새 HEAD가 AI 적용 대기가 된다. AI 확인 전까지 실제 ACTIVE는 기존 버전이며, 실패해도 기존 통화 설정을 유지한다. 따라서 전환 중에는 HEAD와 실제 ACTIVE가 다를 수 있다. HEAD 변경 완료 200은 AI 반영 완료를 뜻하지 않는다.

다른 유형으로 대표 전환이 대기 중이면 그 대상 유형을 우선한다. 예를 들어 친절형에서 신속형으로 전환 대기 중 친절형 HEAD를 변경해도 신속형 대기는 취소하지 않는다. 대기 대상을 바꾸려면 대표 선택 API를 호출한다.

현재 대표 유형의 HEAD를 이미 ACTIVE인 버전으로 복원하면 불필요한 재적용 없이 **동일 유형의 대기**를 취소한다. 다른 유형으로 대표 전환 중인 대기는 유지한다. 동일 HEAD 재요청과 정상 적용 대기는 재사용하고, 실패 대기 재시도에는 새 applicationId를 발급한다.

## 프론트 조회와 표시

GET `/api/personas`와 GET `/api/personas/{id}`에 `headVersion`을 추가한다. 기존 필드는 유지한다.

| 필드 | 화면에서의 의미 |
| --- | --- |
| `latestVersion` | 편집 기본값과 최신 저장 버전. PATCH expectedVersion의 기준 |
| `headVersion` | 유형 카드의 대표 설정·HEAD 버전·작성자. 한 번도 버전 적용하지 않았으면 null |
| `activeVersionSeq` | 실제 AI 적용 완료 버전. 대표에서 제외된 유형은 null |
| `pendingVersionSeq` | AI 반영 대기 버전. 없으면 null |

`headVersion`은 `latestVersion`과 동일한 전체 버전 객체이며 `createdByAdminUserSeq`·`createdByAdminUserName`도 포함한다. 목록의 `total_count`·`hasNext`는 유지한다.

버전 목록에서 HEAD 표시는 버전 식별자와 `headVersion.aiPersonaVersionSeq`를 비교한다. 버전의 `status`만으로 HEAD 여부를 판단하지 않는다. 비대표 유형의 HEAD는 INACTIVE일 수 있다. ACTIVE/PENDING/INACTIVE는 실제 통화 적용 상태이고 작성 중 상태는 추가하지 않는다.

신규 유형의 화면 흐름은 **생성 → 필요시 수정 저장 → 버전 적용 → 대표 선택 → AI 결과 조회**다. 비대표 유형의 수정·HEAD 변경에는 대표 선택을 연이어 호출하지 않는다.

과거 HEAD로 복원해도 `latestVersion`은 되돌아가지 않는다. 이후 PATCH는 기존과 같이 최신 저장 버전에 생략값을 합친다. 과거 버전 내용에서 편집하려면 선택한 버전의 전체 설정을 PATCH에 보낸다.

## 데이터 전환과 검증

신규 앱 실행 전 `034-persona-type-heads.sql`을 적용한다. `ai_personas.head_version_seq`는 같은 유형의 불변 버전을 가리키는 논리 참조이며 API 트랜잭션에서 소속을 검증한다. 새 업무 테이블·상태·이름 컬럼은 추가하지 않는다.

기존 PENDING이 있으면 진행 중인 적용 요청을 이어가도록 해당 버전을 HEAD로 지정한다. 없으면 ACTIVE 또는 성공 감사 이력·appliedAt으로 확인되는 마지막 적용 버전을 복원한다. 단순 최신 저장 버전은 HEAD로 추정하지 않으며, 근거가 없으면 null이다. 기존 설정·통화 참조·감사·활성/대기 요청은 삭제하거나 덮어쓰지 않는다.

HEAD 변경·감사·대표의 적용 대기는 같은 트랜잭션이다. 동시 변경과 AI 회신은 같은 기존 잠금으로 직렬화하고, 교체된 회신은 409로 거절한다. AI 설정 조회·회신의 URL·인증·필드는 바꾸지 않는다.

실제 서버 DB 적용·프론트 수정·AI 코드 변경은 이 백엔드 작업에 포함하지 않는다. 프론트는 기존의 저장 후 자동 적용 가정을 제거하고 새 HEAD/대표 동작을 연결해야 한다. 구버전 앱으로 복구할 경우 HEAD를 갱신하지 않는 구버전의 페르소나 쓰기를 함께 사용하면 HEAD가 오래될 수 있으므로 페르소나 변경을 중단한 상태에서 복구한다.
