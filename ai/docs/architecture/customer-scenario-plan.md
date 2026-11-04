# 기존 고객 출발지·인사 동의·빈 주문 — 계획

상태: 계획(승인 전). 2026-11-04. 근거: 운영 통화 3a0b9c7f(2026-11-04 17:55), 고객별 시나리오 점검.

## 1. 기존 고객의 보내는 분 미리 채우기

### 지금
- 1단계 고객 확인(accept 전)에서 `default_origin`(고객 기본 주소: 이름=고객 이름, 전화=발신번호, 지번·동·우편번호가 있으면 geo)을 받는다. `recent_origin`(이전 접수 출발지)은 2단계(통화 등록) 뒤에만 온다.
- 인사는 "○○님, {등록된 출발지}에서 보내시는 택배 접수 도와드릴까요?"인데, 보내는 분 성함·주소·상세는 처음부터 다시 묻는다(Source.PROFILE은 정의만 있고 쓰지 않음). 운영 페르소나도 "등록 고객은 미리 채워진다"고 적혀 있어 서버와 어긋난다.

### 바꿀 것
| 단계 | 동작 |
|---|---|
| 출발지 후보 | 1단계 `default_origin`(완성 주소: 도로명 + geo). 없으면 인사에 출발지 없음(지금과 같음) → 2단계 뒤 `recent_origin`이 오면 접수 시작 때 "이전에 보내신 {주소}에서 보내시나요?"로 확인(아래 질문 origin) |
| 동의 판정 | Decision 질문 **origin**(yes/no/not_answer)을 출발지를 제안한 뒤 답을 기다릴 때만 넣는다. 인사 "…{출발지}에서 보내시는 택배 접수 도와드릴까요?"에 "네" → task=order(§2) + origin=yes |
| 채우기 | origin=yes면 `sender_name`(고객 이름)·`sender_address`(+geo)·`sender_address_detail`(저장된 상세)을 **Source.PROFILE**로 기록. 받는 순서의 missing은 받는 분 성함부터 |
| 다른 곳에서 보냄 | origin=no("다른 데서 보내요")면 성함만 채우고 주소·상세는 묻는다 |
| 알림 | 접수 시작 알림에 `{"intent":"order","prefilled":["sender_name",…],"missing":[…]}`(§2와 같이) |
| 되읽기 | 보내는 분 성함·주소는 읽고, 저장된 상세주소는 지금 규칙대로 읽지 않는다(읽기 규칙: 저장된 상세주소는 먼저 읽지 않음) |
| 주소 저장 제안 | 보내는 곳 = 기본 주소라 제안하지 않음(지금 규칙 그대로) |

- 정정: 고객이 나중에 "보내는 곳이 달라요"라고 하면 지금처럼 record_fields로 고친다(PROFILE 값을 CUSTOMER 값이 덮음).
- 위험: 저장된 상세주소를 읽지 않아 고객이 상세 오류를 모를 수 있다 → 되읽기 때 "등록된 상세주소로 진행"이라는 말만 넣는다(문장, 값은 읽지 않음).

## 2. 인사 질문에 "예" → 접수 시작, 시작 알림에 다음 질문

### 지금(운영 통화)
- 인사 "택배 접수 도와드릴까요?"에 고객 "예"(7.2s)는 task=chit_chat, "아뇨 아뇨 해주세요"(12.5s)는 order 0.28(기준 0.6 미달) → 무시. Live도 7초 무응답.
- "택배 접수할게요"(19.8s)에서야 order → 서버 알림은 `{"intent":"order"}`뿐 → Live가 "어떤 택배 보내실 건가요?"(순서 이탈).

### 바꿀 것
1. **Decision task·switch 기준**(workflow.toml 문장): "직전 AI 발화가 택배 접수를 도와드릴지 물었고 고객이 동의(예·네·해 주세요·그렇게 해 주세요)하면 order." 같은 예를 instructions에 넣는다.
2. **접수 시작 알림에 상태 요약**: `_on_intent`의 order 알림에 `state_summary`(stage·missing)와 §1의 prefilled를 붙인다 → Live가 missing 첫 항목(보내는 분 성함, 또는 채웠으면 받는 분 성함)을 묻는다.
3. (운영, 코드 아님) BE 관리자 페르소나를 페르소나 절만 남긴 새 버전으로 적용 — 예전 규칙의 "진행 상태"·"통화 정보의 첫 질문"이 순서 기준을 흐린다.

## 3. 택배 정보 없는 통화의 빈 주문 방지

### 지금
- 용건이 order인데 담은 택배·받던 값이 없으면 `INCOMPLETE NO_CONFIRMED_PARCEL`을 보낸다. 결제 가능 방식이 하나면 `paymentMethodType`이 자동으로 들어가 BE가 주문 정보로 보고 **COLLECTING 주문 생성**(운영 orderSeq 59). BE 규칙(`empty-ai-order-results.md`): parcels 비고 `paymentMethodType`·`pickupRequestedAt`·`totalAmount`가 없어야 NO_ORDER.

### 바꿀 것
- `decide_outcome`: 담은 택배도 받던 값도 없으면 `payment`·`pickup_at`을 넣지 않는다(INCOMPLETE 그대로 → BE NO_ORDER, orderSeq null).
- 가짜 BE: 같은 조건에서 NO_ORDER(orderSeq null)를 돌려주게 흉내(계약 테스트).
- 관제: 결과 상태 NO_ORDER를 그대로 표시(이미 status 표시).
- 운영 orderSeq 59는 BE에서 정리 여부 확인(AI는 지우지 않음).

## 4. 단계
1. §3(작음, 데이터 오염 방지 — 먼저).
2. §2-1·2(문장 + 알림).
3. §1(origin 질문, PROFILE 채우기, recent_origin 확인).
4. 테스트: 빈 결과 본문에 결제·수거 없음, 가짜 BE NO_ORDER · 인사 "예" → order(가짜 Decision) · 접수 시작 알림에 missing · origin yes → 보내는 분 3항목 PROFILE·missing이 받는 분 성함부터, no → 성함만 · 되읽기에 저장 상세 미포함 · 저장 제안 없음.
5. worklog·커밋 → MR → 운영 통화로 확인(BE 페르소나 정리 후).

## 5. 확인 필요
- 기본 주소가 없고 최근 출발지만 있는 고객에게 "이전에 보내신 곳에서 보내시나요?"를 물을지(§1 recent_origin) — 권장: 물음.
- 탈퇴 고객(WITHDRAWN)은 이번 범위 밖(신규처럼 진행, 자동 등록 안 함 — 지금 동작).
