# 도구(tool) 구조

## 현재 추가된 검색 도구

`search_manual(question)`은 읽기 전용 FAQ 검색이다. 주문·접수 정보는 바꾸지 않고, 결과로 RAG Yes/No 사건(`rag.found`·`rag.none`·`rag.failed`)을 내 QnA 흐름을 움직인다(어느 단계에서나 쓸 수 있다, `spec/scenario.md` D). 기존 디스패처의 strict 인수/단계 검증을 거치고 raw Top3와 구간별 시간을 반환한다. client 모드(보류)는 `config/live.toml`의 `[backend.tools]`에서 도구 이름을 채우며, 결과를 Live에 직접 보낸다. 아래 Responses 결과 반환 설명은 복귀 모드에만 해당한다.

도구는 늘어날 것이므로, **도구 하나를 추가할 때 파일 하나만 만들면** 되게 한다.

- 모든 도구는 `app/tools/` 디렉토리에 둔다. 파일 하나에 도구 하나(가까운 도구 몇 개를 묶어도 되지만 파일 이름이 기능을 드러내게). 공용 부품(기반 클래스, 레지스트리, 전화번호 정규화 등)은 `app/tools/_base.py`처럼 `_`로 시작하는 파일에 둔다.
- 도구 하나 = **이름 · 설명 · 인수 모델(pydantic) · async 실행 함수**. 도구는 자기가 어느 단계에서 쓰이는지 모른다(허용 여부는 단계 쪽이 선언, `spec/flow.md`). 실행 함수는 `(ctx, args) -> 결과`이며, 상태를 바꾸는 일이 있었으면 단계를 직접 바꾸지 않고 이름 있는 사건(예: `order.submitted`)을 낸다. `ctx`는 자기 통화의 컨텍스트(통화 상태, 임시 주문, 발신번호, 백엔드 API, 서버 설정)다. 전역 상태에 손대지 않는다.
- **자동 등록**: 서버 시작 시 `app/tools/` 안의 모듈을 모두 import해 레지스트리에 모은다(데코레이터 등록 등). 이름이 겹치면 기동 실패. 도구 목록을 손으로 적는 곳은 `config/live.toml`의 `delegation.responses.tools`뿐이며, 이름만 적으면 레지스트리에서 설명·strict JSON 스키마를 채운다. 설정에 없는 도구는 모델이 쓸 수 없다.
- **실행 파이프라인은 한 곳**(디스패처): 도구 찾기 → 인수 검증 → 허용 상태 확인 → 실행(시간 제한) → 결과 직렬화 → 상태 전이 반영 → 관제 기록 → `function_call_output` + `response.create`. 개별 도구는 이 과정을 다시 구현하지 않는다. 없는 도구·검증 실패·허용되지 않은 상태·예외·시간 초과도 모두 오류 결과로 돌려준다.
- **결과 형식 통일**: 성공 `{"ok": true, ...}` / 실패 `{"ok": false, "error": "...", "retry": "다시 확인할 것"}`. 모든 결과에 현재 통화 상태 요약(`spec/flow.md`)을 붙인다. 내부 예외 메시지·스택은 모델에 주지 않고 로그로만.
- 외부 연동(요금 API, 알림톡, 상담원 전환 등)이 생기면 도구는 그대로 두고 그 연동 모듈만 바꾼다.
- `cancel_order`(서버만 부름): 인수는 조회에서 확인한 `order_seq`·`order_parcel_seq`(백엔드 정수 번호)와 `customer_confirmed`·`operation_id`. 주문 상세 하나를 취소한다(`spec/backend-api.md` 2번). 결과 사건 `cancel.done`·`cancel.already`·`cancel.locked`(결제가 끝나 취소 불가)·`cancel.failed`.
- **도구는 값 기록과 주문 작업에만 쓴다.** 고객 답(예/아니오·고르기·용건·상담원·종료)에 따른 상태 전환은 도구 왕복의 지연을 피하려고 서버가 고객 말을 직접 판별한다(`spec/flow.md`). 새 질문을 만들 때 도구를 만들지 말고 단계의 `choices`·`on_answer`로 만든다. 예외: 주소록 찾기·조회·취소 결과로 정해지는 분기는 도구 결과 사건으로 정한다.
- 주문 값 기록(`record_order`)은 단계가 막지 않는다: 접수 업무가 있을 수 있는 단계(`HUB`·`ORDER`·`A_CONFIRM`·`A_CHOICE`·QnA·상담원 제안)에서 모두 받는다. 단계가 허용하지 않는 도구는 거절하고 진행 상태를 음성 모델에 다시 보낸다(`spec/flow.md` 멈춤 막기).
- 고객 확인이 필요한 도구(수정·취소)는 인수에 `customer_confirmed`를 두고 도구 안에서 `require_confirmed`로 거절한다. 쓰기 도구는 작업 번호(`operation_id`)를 받아 `Call.running_ops`에 남긴다.
- 지금 도구: `get_state`, `record_order`, `match_pins`, `lookup_orders`, `answer`, `switch_task`, `cancel_order`, `search_manual`, (`modify_order` 보류). `get_state`·`search_manual`·`switch_task`는 끝내는 단계 밖 어디서나 쓴다(`engine.ANYWHERE`).
  - `answer`: 음성 모델이 알아들은 고객 답(지금 질문의 답)을 보고한다. 인수 `choice`는 `state.choices`의 키 하나(서버가 다시 검사). 고를 답이 있는 단계에서만 허용된다(`engine.answers_by_tool`). 확인 단계에서는 동의(`Stage.consent`)만 두 열쇠의 한쪽으로 남기고(서버 판별과 같아야 처리, `spec/flow.md` "두 열쇠"), 거절 같은 다른 답은 아무것도 하지 않는다(서버 판별이 처리).
  - `switch_task`: 하던 것과 다른 일로 바꾼다. `order`(→ `ORDER`), `lookup`(→ 조회), `agent`(→ 제한된 요청·상담원 제안), `end`(→ 마무리 인사 후 종료). 이미 그 업무 중이면 아무것도 하지 않는다.
  - `record_order`: 택배 항목(이름·연락처·주소·규격별 수량·기타 물품·물품 가액·요청 사항)과 통화 항목(수거 희망 시각 `pickup_at`, 전화 주신 분 성함 `customer_name`)을 기록한다. 수거 시각은 시간대가 있는 미래 시각만 받아 한국 시간으로 바꾸고, 지난 시각이면 `pickup.past` 사건(A5_PAST를 한 번 알림)을 낸다. 새 주소는 기록하면서 주소DB·카카오로 확정한다(`spec/address.md`). 단, 받는 분이 정해지기 전의 받는 곳 주소는 먼저 주소록에서 비슷한 핀을 찾고, 있으면 받는 분 값을 기록하지 않고 `pins.one`·`pins.many`로 그 핀을 확인하게 한다(결과 `saved_place_found`). 이미 채운 값이 바뀌면 정정으로 보고 한 번 확인하게 한다. 제안(기존 출발지·최근 도착지)에 답하지 않고 새 값을 말했으면 제안을 지우고, 신규 고객의 보내는 분 정보가 다 차면 고객 등록(통화에 한 번)을 한다.
  - `match_pins`: 이름·장소·층/호수로 개인 주소록을 찾고, 기업명 `organization`·부서 `department`가 있거나 개인 주소록에 없으면 기업 검색 API를 호출한다(`ORDER`에서만). `restart=true`는 다른 수신인으로 정정하며 이전 조건/후보를 지운다. false는 같은 대상의 추가 조건을 누적한다. 기업 검색 응답이 늦으면 검색 세대를 확인해 폐기한다. `pins.more`는 전체 결과가 표시 상한을 넘거나 다음 페이지가 있어 기업·부서·이름을 더 묻는다. 장애는 ToolError와 `COMPANY_FAILED`로 안내하며 0건으로 바꾸지 않는다. 결과 사건 `pins.one`(확인 B9)·`pins.many`(후보 B8)·`pins.none`(고객이 말한 이름·장소를 받는 분 정보로 가져감), 못 찾았는데 이름·장소 중 한쪽만 말했으면 `pins.ask_name`·`pins.ask_place`(빠진 쪽을 묻는다). 최근 도착지 제안 중에 다른 곳을 말한 것이면 제안을 지운다.
  - `lookup_orders`: 발신번호로 접수된 택배를 받는 분 성함으로 찾는다(성함이 null이면 최근 것부터). 결과 사건 `lookup.found`·`lookup.none`·`lookup.failed`. 백엔드 옛 계약(`/internal/ai/orders/search`)이라 실제 백엔드에서는 실패한다(`spec/backend-api.md`).
  - `cancel_order`: **서버만 부른다**(고객의 "예"를 확정 지연 뒤 `C_CANCEL`에서, `config/live.toml` 백엔드 도구 목록에 없음). 앞 시도의 결과가 불확실하면 다시 보내기 전에 조회로 이미 취소됐는지 확인한다. 결과 사건 `cancel.done`·`cancel.already`·`cancel.picked`·`cancel.failed`.
  - `modify_order`는 **사용 보류**(LANGGRAPH_REBUILD §5.4 수정 보류). 코드와 테스트만 남기고 백엔드 도구 목록과 단계에서는 뺐다.
- 도구마다 단위 테스트 하나 이상(정상, 인수 오류, 허용되지 않은 상태). 레지스트리 테스트: 모든 도구의 스키마가 strict로 생성되는지, `live.toml`의 함수 도구 이름이 모두 레지스트리에 있는지(서버 전용·보류 도구 제외).
