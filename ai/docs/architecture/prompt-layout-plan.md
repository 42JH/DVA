# 구조 계획 v5 — 서버가 업무 규약을 강제, 프롬프트는 파일로 분리(페르소나만 BE)

상태: 계획(승인 전). 2026-11-04. v4에 **BE 합의 계약**(`docs/be-requests/2026-11-04-pickup-callback-handoff-pins.md`)을 반영했다.

## 0. 결정
- 업무 규약은 **서버 코드가 강제**한다(단계·확인 관문·검증·전송 조건). 프롬프트에 의존하지 않는다.
- 프롬프트는 파일로 분리한다: 페르소나만 BE `promptText`, 업무 규약 문장은 저장소 파일(운영 중 수정 없음).
- BE 계약: 위 합의 문서가 계약이다. BE는 1(수거 요청 시각 보존)·2(콜백 요청 API)·4(주소록 갱신)를 구현했다(사용자 전달). 3(상담원 이관)은 AI가 **요청만** 보낸다(임시).

| # | 결정 | 서버가 강제하는 것 | 계약 |
|---|---|---|---|
| a | 수거 일시: 기본 = 통화 시각 + 1시간(09:00 전이면 당일 09:00, 17:00 넘으면 "금일 수거 어려움, 익일 가능" + 익일 09:00). 고객 요청 시 09~17시·3일 이내(임시)에서 조정 | 기본값 계산, 범위 검증(거절 코드), 되읽기·확인 스냅샷, 전송 `pickupRequestedAt` | 합의 1: BE가 보존·디버 접수에 사용 |
| b | 확인 답은 서버 Decision(위임 안 함) | 지금과 같음 | — |
| c | 새 번호는 받은 직후 끊어 읽어 확인(`phones_to_read`) | 지금과 같음 | — |
| d | 번호 정정은 틀린 부분만 | Backend 규칙으로 합친 전체 번호 + 서버 자릿수 검증 + 되읽기 재확인 | — |
| e | 상담원 이관 권유. 불만·격앙은 Live가 판단. 근무 시간 외는 콜백 안내 | 이관 조건 판정, 고객 동의 후 **이관 요청 전송**(콜백 요청 API), 분석·이벤트. 통화 전환 없음 | 합의 2·3 |
| f | 등록 고객 인사에 성함·등록 출발지 | 통화 정보에 기본 출발지 | — |
| g | 출발지·최근 도착지가 바뀌면 **주소 인식 시** 주소록 수정 | 주소 확정 직후 백그라운드로 고객 주소·PIN 갱신 | 합의 4 |
| h | 같은 질문 3회 연속 답 못 하면 이관 권유, 해결되면 0 | 서버가 질문별로 세고 3회면 이관 사실 전달 | — |
| i | 주소를 말할 때 받아 쓰듯 되풀이 | 프롬프트만(기존 "주소 다시 말하지 않음" 삭제) | — |

## 1. 프롬프트 파일 구성

```
Live instructions = [페르소나] + [업무 규약] + [통화 정보]
  페르소나     BE ACTIVE promptText, 없으면 policy/persona_default.md
  업무 규약     policy/business_rules.md   제시 프롬프트의 업무 절(§1.1 수정 반영)
              + policy/workflow.toml 렌더  받는 순서·단계·위임 기준·금지·서버 결과 읽는 법(서버 판정과 같은 데이터)
  통화 정보     시각, 등록 여부, 성함, 기본 출발지(f)
Backend instructions = policy/backend_rules.md (render_backend 문장 이동 + d 번호 합치기)
```

- 우선순위: "업무 규약이 페르소나보다 우선"을 `business_rules.md` 첫머리에. `render.py:59`의 "충돌 시 페르소나 우선" 삭제.
- 받는 순서·단계·위임 기준·서버 결과 키는 `workflow.toml`에서만 렌더. `business_rules.md`에 순서를 다시 쓰지 않는다.
- `policy/default_prompt.md` → `persona_default.md`(말투) + `business_rules.md`(업무)로 나누고 삭제.
- BE 관리자 ACTIVE `promptText`는 페르소나 절만 남긴다.

### 1.1 제시 프롬프트 → `business_rules.md`에서 고칠 문장
- "진행 상태" → "서버 결과(도구 결과·`[서버 결과]` 알림)". "통화 정보의 첫 질문" → "서버 결과의 missing 첫 항목".
- 백엔드에 맡기는 일: "확인 질문의 답도 맡긴다" 삭제(b).
- 전화번호: "받은 직후 되읽지 않는다" → c. 정정은 d.
- 수거: a. 예문은 영업시간 안으로("내일 오전 열 시").
- 검색 자료: "여러 조각·전달 완료 신호" → 결과 한 번(근거 최대 3개).
- 상담원: 연결 멘트 "담당 상담원에게 바로 연결해 드리겠습니다"는 **전환이 없으므로** "담당자가 확인 후 연락드리겠습니다"로(임시, 합의 3). 근무 시간 외 콜백 멘트는 그대로(서버 결과 뒤에만). `transferCall`·`create_callback_request` 이름은 실제 도구 이름으로.
- 마무리: "이용해 주셔서 감사합니다. 좋은 하루 보내세요" 고정(서버 `closing` 뒤).

## 2. 기능별 서버 변경

### a. 수거 일시(결정 1-b 철회, 합의 1)
- 필드 `pickup_at` 재도입: `workflow.toml` 필드·단계, `record_fields` 인자, 되읽기·확인 스냅샷.
- **기본값**: 통화 시작 시각(`incomingAt`, KST) + `lead_hours`. 09:00 전 → 당일 09:00, 17:00 넘음 → 익일 09:00 + 사실 `pickup_today_unavailable`. 고객에게 묻지 않고 기본값을 안내. 주말·공휴일 구분 없음.
- **조정**: `parse_pickup`(`app/domain/rules.py`) → `현재 + 1시간 ≤ 시각`, `09:00 ≤ 시각 ≤ 17:00`, `시각 ≤ 오늘 + 3일` 아니면 `rejected`(`PICKUP_TOO_SOON`·`PICKUP_OUT_OF_HOURS`·`PICKUP_TOO_FAR`) + 허용 범위 사실.
- 설정 `config/server.toml [pickup]`: `lead_hours=1`, `open="09:00"`, `close="17:00"`, `max_days_ahead=3`(임시), `next_day_default="09:00"`.
- **전송**: 결과 본문 `pickupRequestedAt`(ISO 8601, `+09:00`). COMPLETE 조건에 포함(값이 있어야 COMPLETE). BE가 보존·디버 접수에 사용(합의 1). 결제 지연으로 요청 시각이 지나는 경우는 BE 처리(합의 1-2).
- 가짜 BE: `pickupRequestedAt` 형식 검증·보존 흉내. 계약 테스트 픽스처 갱신.

### d. 번호 부분 정정
- `backend_rules.md`: "고객이 번호 일부만 고치면 기록된 번호에서 그 부분만 바꾼 전체 번호를 넣는다".
- 서버: 자릿수·정규화 검증 그대로, 바뀐 번호는 `phones_to_read`로 다시 끊어 읽어 확인.

### e·h. 상담원 이관(합의 2·3, 통화 전환 없음)
- **이관 조건**: ① 고객의 연결 요청 → Decision 용건 `agent` ② 불만·격앙 → Live가 판단해 권유(프롬프트), 고객이 동의하면 ① ③ 같은 질문 3회 연속 답 못 함(h): `search_manual`의 `KB_NO_EVIDENCE`·`KB_LOW_SCORE`·`unavailable`를 질문별로 세고 답이 나오면 0 → 3회면 N2 `{"agent":"suggest"}`.
- **이관 요청**: 고객 동의(`agent` 판정) 후 콜백 요청 API로 전송 — `POST /api/ai/calls/{callSessionSeq}/callback-requests`, `Idempotency-Key`, `{providerCallId, name, phoneNumber, reason, requestedAt}`, 응답 `callbackRequestSeq`(합의 2). `reason`: `CUSTOMER_REQUEST`·`COMPLAINT`·`REPEATED_UNANSWERED`·`OUT_OF_HOURS`(근무 시간 밖). 성함은 보내는 분·고객 성함, 연락처는 발신번호(없으면 고객에게 받음).
- 전송은 백그라운드·아웃박스(재시작 복구, 같은 키). 결과는 N1'(무음) 사실, 안내는 "담당자가 확인 후 연락"(통화 전환 없음).
- 분석 `hasHandoffRequest=true`, 이벤트 `HANDOFF_REQUESTED`는 지금처럼.
- 설정 `config [agent]`: 상담원 근무 시간(사유 `OUT_OF_HOURS`·멘트 선택용). 상담원 SIP URI는 비움(전환 기능은 나중에 `refer`로).
- 통화 등록 전(`callSessionSeq` 없음)이면 2단계 고객 확인을 먼저 끝낸 뒤 전송.

### f. 등록 고객 인사
- 1단계 고객 확인의 기본 출발지(고객 기본 주소, 없으면 최근 출발 PIN)를 통화 정보 "등록된 출발지"(도로명·건물번호, 상세주소 제외)로.

### g. 주소 인식 시 주소록 갱신(합의 4)
- **시점**: `record_fields`에서 주소가 확정된 직후(보정 confirmed·후보 선택 반영), 대화와 별개로 백그라운드.
- **출발지**: 등록 고객이고 확정 주소가 고객 기본 주소와 다르면 `PATCH /api/customers/{id}` `address`.
- **도착지**: 주소록 PIN에서 고른 도착지가 바뀌었으면 `PATCH /api/pins/{id}`(addressData 전체), 새 도착지면 `POST /api/customers/{id}/pins`(409 `DUPLICATE_RESOURCE`는 이미 있음으로 처리).
- 같은 주소로 중복 호출하지 않는다(통화별 기록). 실패는 대화에 영향 없음(관측만).
- 남은 확인(합의 문서 4-2·4-3): 통화 등록 전 "현재 통화 고객" 권한, 고객 기본 주소 변경에 고객 동의가 필요한지 → **BE 구현 문서로 확인**. 필요하면 동의 질문(Decision confirm 재사용)을 넣는다.
- 미등록 고객은 지금처럼 등록 절차(고객 등록 → 재확인 → PIN)로.

### i. 주소 맞장구
- 프롬프트만.

## 3. 계약 대조(구현 시작 전)
BE 구현 코드·문서가 원격(`develop-backend`)에 올라오면 합의 문서와 대조한다: 콜백 API 경로·인증·필드·오류, `pickupRequestedAt` 검증 오류 코드, PIN·고객 수정 권한 범위. 다르면 BE를 따르고 합의 문서를 고친다. 대조 전에는 a·e·g의 BE 호출부를 구현하지 않고, 계약과 무관한 부분(§4 단계 2·3)부터 한다.

이전 확인 기록(2026-11-04, `e5dc008`): a는 당시 BE가 결제 시 덮어써 충돌(→ 합의 1로 해소), e는 BE API 없음(→ 합의 2), g는 기존 API로 가능.

### 3.1 BE 구현 대조(2026-11-04, `origin/feature/ai-call-updates` 9a5d032 — develop-backend 미머지)
BE 문서 `backend/docs/ai-call-follow-up.md`, `backend/docs/ai-integration-current.md`(2026-11-04판)가 **실제 계약**이다(합의 문서와 다르면 BE를 따른다).

| 항목 | BE 구현 | 합의 문서와 차이 → AI 반영 |
|---|---|---|
| a 수거 | `pickupRequestedAt`(시간대 포함 ISO)을 결제 대기 중에도 보존. 결제가 요청 시각 이전·같으면 유지, 이후면 결제+1시간을 09~17시로 맞춤(17시 초과 → 다음날 09시). AI 값에 영업시간·일수 제한 없음. 카드·월·그룹 동일, 재접수 재계산 없음 | 같음. AI 쪽 09~17시·3일·+1시간 검증은 AI 업무 규칙으로 유지 |
| e 콜백 | **별도 API 없음.** 최종 분석 `POST /api/ai/calls/{seq}/analysis`에 `hasCallbackRequest: true/false/null` 추가(이름·연락처·사유·멱등키 없음 — 연락처는 통화 발신번호, 이름은 고객 이름). `hasHandoffRequest`와 독립, 연결 요구로 콜백을 추정하지 않음. 주문 없는 콜백 통화도 `call` 등록 필요 | §2 e의 "콜백 요청 API" 대신 **분석 필드 1개**. 아웃박스 불필요(분석 전송에 포함). **배포 순서**: 048 + 새 BE 전에는 구버전 BE가 새 필드를 400으로 거절 → AI는 설정 플래그로 켠다 |
| g 기본 주소 | `PATCH /api/customers/{id}` `address` + **`call_session_seq` 헤더 필수**, **진행 중 본인 통화만**(종료 후 409, 헤더 없음 400, 다른 고객 403). **고객 동의 후에만** | 통화 중에 끝내야 함. 헤더는 새 BE 전에 먼저 넣어도 됨(구버전은 무시) |
| g PIN | `POST /api/customers/{id}/pins`·`PATCH /api/pins/{id}`는 종료 후에도 같은 통화 고객이면 허용. 목록 `GET`은 진행 중만(종료 후 409) — 종료 전에 PIN 번호·주소 확보. 주소 중복 409 `DUPLICATE_RESOURCE`. **고객 동의 후에만** | "주소 인식 시 자동 갱신"이 아니라 **동의 질문 필요** |
| 공통 | 주문 저장은 기본 주소·PIN을 자동 갱신하지 않음. 주소/PIN 실패는 주문 성공을 되돌리지 않음 | 같음 |

남은 결정: ① 주소 저장 동의를 언제·어떻게 묻는지 ② 이관(전환 없음)을 `hasCallbackRequest=true`로 볼지 ③ 새 BE 배포 전 플래그 기본값.

## 4. 단계
1. BE 구현 확인(§3) — 원격 반영되면.
2. 프롬프트 분리(§1): `persona_default.md`·`business_rules.md`·`backend_rules.md`, `render_live`·`render_backend` 정리.
3. f 통화 정보, i 문장, d Backend 규칙, h 답 못 한 횟수·이관 사실.
4. a 수거 일시(필드·검증·설정·되읽기·전송·가짜 BE).
5. e 이관 요청 전송(아웃박스), g 주소록 갱신.
6. 테스트: 렌더(페르소나 맨 앞·규약 항상·우선순위), 수거 기본값(09 전·17 넘음)·범위 거절, 부분 정정 되읽기, 이관 횟수 초기화·요청 멱등, 주소록 갱신 시점·중복 방지·409, 계약 본문(`pickupRequestedAt`·콜백 요청).
7. worklog·커밋 → 로컬 실통화(가짜 BE) → MR.

## 5. 위험
- a: BE 검증 규칙이 AI와 다르면 400/422(INCOMPLETE) — §3 대조로 맞춘다.
- d: 부분 정정 오합성 → 되읽기 재확인으로만 막는다.
- e: 전환이 없어 고객은 즉시 상담원과 통화하지 못한다(임시). 안내 문구가 실제와 같아야 한다.
- g: 주소 인식 시점에 갱신하므로 **접수를 끝내지 않고 끊어도 주소록은 바뀐다**. 고객이 뒤에 정정하면 같은 통화에서 다시 갱신한다.
- 지연: 규약 파일 길이 → 실통화 P50·P95. 이관 요청·주소록 갱신은 백그라운드라 대화 지연 없음.
