# 페르소나 항목별 저장 — 프론트 연동 명세

2026-11-09. 기존 API를 재사용한다. 새 앱 전에 `060-persona-prompt-fields.sql`을 적용한다. 프론트·AI·MSA 코드는 변경하지 않는다.

| 화면 | API 필드 | DB 컬럼 |
|---|---|---|
| 역할 | role | role_text |
| 성격 | personality | personality_text |
| 발화 톤 | tone | tone_text |
| 속도 지시문 | speedInstruction | speed_instruction |
| 맞장구 | backchannel | backchannel_text |
| 끼어들기 | interruption | interruption_text |

`POST /api/personas`는 code·name과 위 6개 문자열이 필수다. 각 항목은 비공백 문자열이며 제목 없이 본문만 보낸다. 줄바꿈·원문은 보존한다. 기존 voiceId·speakingRate·turnWaitLevel과 권한은 유지한다. speedInstruction은 숫자 speakingRate와 별개다.

```json
{
  "code": "dva",
  "name": "디바",
  "role": "택배 서비스의 AI 전화 상담사입니다.",
  "personality": "열정적이고 밝게 응대합니다.",
  "tone": "한국어 존댓말로 간결하게 안내합니다.",
  "speedInstruction": "이해할 수 있는 선에서 빠르게 말합니다.",
  "backchannel": "주소를 말할 때만 작게 되풀이합니다.",
  "interruption": "고객이 끼어들면 즉시 멈춥니다.",
  "voiceId": null,
  "speakingRate": null,
  "turnWaitLevel": "NORMAL"
}
```

`PATCH /api/personas/{id}`는 기존 expectedVersion·expectedDraftRevision과 변경한 항목만 보낸다. 생략한 값은 기존 초안, 초안이 없으면 HEAD에서 유지한다. 전송한 문자열은 빈 값·null을 거절한다. 저장은 초안만 변경하고 HEAD 확정·실제 적용 절차는 유지한다.

```json
{
  "expectedVersion": 4,
  "expectedDraftRevision": null,
  "tone": "차분한 한국어 존댓말로 안내합니다."
}
```

생성·수정의 promptText 입력은 400이다. 본문 항목을 바꾸면 서버가 고정 제목 순서로 조합하여 기존 prompt_text에 전체 본문 스냅샷을 저장한다. 조합 결과는 Python과 같은 Unicode 문자 수로 20,000자 이하이며 초과하면 422 BUSINESS_RULE_VIOLATION이다. 현재 AI 기본 한도와 일치하며 운영 AI 한도를 별도로 변경했다면 함께 확인한다.

목록·상세의 latestVersion/headVersion/activeVersion/pendingVersion/draft, 버전 이력, 생성·수정·확정·activate 응답에 6개 문자열을 추가한다. 기존 promptText는 읽기 전용 전체 미리보기로 유지한다. 페이지·정렬·작성자·건수·권한·409 동시 수정 검사는 유지한다.

## 기존 데이터 전체 이관

기존 페르소나를 삭제하거나 한 개로 교체하지 않는다. 버전과 초안 모두 명확한 한글·영문 제목의 본문을 해당 필드로 분리한다. 분류할 수 없는 장·업무 규칙·자유 본문은 역할에 보존하고, 원문에 없는 항목은 빈 문자열로 저장한다. 신규 등록에는 6개 비공백 값이 필요하지만, 과거 이관 건의 미입력 항목은 그대로 조회·보존하며 부분 수정할 수 있다.

기존 prompt_text는 바꾸지 않는다. ID·버전·작성자·시각·초안 UUID·ACTIVE/PENDING·통화 참조도 유지한다. 기존 설정의 이름·음성만 바꾸거나 같은 항목 값을 다시 저장하면 전체 본문도 유지한다. 본문을 실제로 수정한 새 초안부터 고정 형식을 사용하고 확정 시 새 버전으로 보관한다. 060 이후 6개 컬럼도 기존 버전 변경 금지 대상이다.

## AI 연동

기존 GET /api/ai/config와 POST /api/ai/config/apply-result 응답 형식을 유지한다. 관리자용 6개 필드·작성자 이름은 추가하지 않는다. AI가 받는 promptText는 저장된 전체 스냅샷이며 과거 버전은 이관 전 원문 그대로다. 새 본문은 다음 순서다.

```markdown
# 페르소나

## 역할
{role}

## 성격
{personality}

## 발화 스타일
### 톤
{tone}

### 속도
{speedInstruction}

## 맞장구
{backchannel}

## 끼어들기
{interruption}
```

확정·activate 요청 본문, 변경 알림·재시도·AI 적용 회신·진행 중 통화 버전 고정을 유지한다. 프롬프트를 감사·오류 로그에 넣지 않는다. 실패 시 기존 초안·버전·적용 상태를 트랜잭션으로 보존한다.

## 전환

060은 기존 컬럼을 삭제하지 않는다. 구 백엔드는 prompt_text를 계속 읽을 수 있지만 6개 필드 입력은 지원하지 않는다. 신 백엔드는 promptText 쓰기를 거절하므로 프론트의 저장 요청 전환을 함께 맞춘다. MSA는 msa/README.md의 고정 기준 유지 정책에 따라 변경하지 않는다.
