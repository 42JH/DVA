# Tool Calling 계약 (현행)

> **S3(2026-11-03)로 대체됨.** 옛 `tools/` 패키지는 삭제했고 아래 §1~§4는 옛 계약 분석(기록)이다. 현행 계약은 바로 아래 §0.

## 0. 현행 도구 계약 (`app/tools/`)

**결과 형식** `ToolOutcome.to_output()`: `{status, code?, facts?, needs?: [{field, reason}], stage?, fields?, missing?, next_field?, can_proceed?, parcels?}`. `status` ∈ ok · needs_input · needs_choice · needs_confirmation · rejected · unavailable · unknown(`error-recovery.md` §1). 값 기록 결과에는 상태 요약(fields = 필드별 상태, 값은 없음)을 붙인다. `next_field`는 서버가 수집 순서에서 지정한 다음 질문 항목이다.

**접수 확인 답변**: 서버가 접수 동의를 확인한 발화에서 상태만 보는 `get_state`가 호출되면 `confirmation: await_server`를 반환한다. 음성·Backend는 상태 안내를 기다리고, 같은 발화에 새 값이 있으면 `record_fields`로 기록한다. 서버는 그 기록과 기존 접수 확인이 일치할 때 확정한다.

**취소 확인**: 방금 조회한 택배를 가리키면 서버가 선택한 대상을 바로 확인한다. 새 대상을 찾을 때는 `lookup_orders.scope`의 이번 통화·직전 통화 범위를 취소에도 적용한다. 기존 주문에 속한 모든 택배의 취소를 명시했으면 `whole_order=true`로 해당 주문을 찾는다. 조회나 후보 선택으로 대상이 하나로 정해지면 `cancel_target.question`을 그대로 묻는다. 서버는 그 질문을 들은 뒤 받은 동의와 대상이 일치할 때 취소한다. 거절되거나 실패한 조회 결과로 기존 선택을 확인하지 않는다.

**받는 곳 부분 변경**: 개인 주소록·이전 도착지 후보 확인에서 서버가 `destination_change_question`을 보내면 후보 이름을 포함한 질문을 그대로 한다. `destination_partial_change`가 `address`이면 기존 이름·연락처를 유지하고 새 주소를 받는다. `recipient`이면 기존 주소·상세주소를 유지하고 새 이름·연락처를 받는다. 구체적인 새 값만 `record_fields`에 넣는다. 범위 확인 중 받은 새 값은 현재 후보에 보관해 답변 후 검증한다. 주소로 검증되지 않고 도로명·지번과 번호도 없는 입력은 `RECEIVER_ADDRESS_VALUE_REQUIRED`를 반환한다. 부분 변경 중 `find_destination`은 `DEST_CHANGE_USE_RECORD`와 현재 누락 항목을 반환한다.

**개인 주소록 후보**: 받는 분 이름이 기록된 택배는 두 도구 모두 이름이 일치하는 후보만 찾는다. 이름이 아직 없으면 주소로 후보를 제안할 수 있다. `find_destination`에 기록된 이름과 다른 이름이 들어오면 `DEST_RECIPIENT_USE_RECORD`를 반환한다. 고객이 이름을 정정하면 `record_fields`에 실제로 들은 이름을 넣는다.

**접수 조회 주소**: 선택된 택배의 `lookup_order`에 `sender_address_detail`과 `receiver_address_detail`을 해당 기본주소와 함께 전달한다. 빈 문자열은 상세주소 없음, 누락은 조회 결과로 확인할 수 없음을 뜻한다.

**받는 분 연락처**: `record_fields.receiver_phone`에 말끝까지 들은 번호 표현을 넣는다. 끝 네 자리 정정은 `끝 네 자리 사팔팔이요`처럼 전달하며 서버가 기존 번호에 합쳐 검사한다. 가능한 번호가 하나면 `facts.receiver_phone_readback`에 기록한 숫자를 반환한다. 유효한 해석이 없거나 여러 개면 `PHONE_INVALID_DIGITS` 또는 `PHONE_AMBIGUOUS`와 `facts.phone_question`을 반환한다. 정정이 해결될 때까지 기존 번호는 내부에 보존하고 접수와 조회용 현재 값에는 사용하지 않는다.

**실행기** `run_tool(ctx, name, arguments, call_id, allowed=None)`: 같은 `call_id` 재수신은 처음 결과 그대로 → 허용 확인(`TOOL_NOT_ALLOWED`, 인수 검증보다 먼저) → strict 인수 검증(`TOOL_ARGS_INVALID` + needs에 필드 경로) → 예산 안 실행(도구 3초·RAG 12초 → `TOOL_TIMEOUT`/`KB_TIMEOUT`) → BE 실패는 `BackendFailure.code`, 그 밖 예외는 `INTERNAL_ERROR`(모두 unavailable).

`find_destination(recent=true)`는 통화 시작 때 불러온 최근 도착지(`Source.HISTORY`)만 조회한다. 기존 주소 이력 API의 최근순과 `_apply_context`의 중복 제거를 재사용하고, 이름·장소·상세 조건이 있으면 함께 적용한다. 개인 핀·기업 검색으로 대체하지 않으며 후보는 기존 `max_pin_options`만큼 제시하고 1건이어도 고객 확인을 거친다. 반복 목록 요청은 선택으로 취급하지 않는다. 이력이 없거나 조건에 맞지 않으면 `DEST_NONE`과 `facts.found=0`을 반환한다. 기업·부서와 recent를 함께 요청하면 `TOOL_ARGS_INVALID`다. recent 없이 모든 문자열이 비어 있으면 기존 `NOTHING_TO_RECORD`를 유지한다. 발송지 처리 때문에 후보 제시를 보류한 `DEST_DEFERRED`는 검색 결과 없음과 다르며, 후보 값은 노출하지 않고 찾은 수와 보류 이유만 반환한다.

| 모델 도구(strict) | 인수 | 결과 |
|---|---|---|
| `record_fields` | 보내는 분 성함·주소·상세, 받는 분 성함·연락처·주소·상세, 수량 4종·기타 물품, 물품 가액, 요청사항, 수거 시각(들은 항목만) | ok / needs_choice(받는 분 성함·주소가 주소록과 일치하면 발송 기본주소·상세주소 확인 뒤 이름표 제시, 후보는 `state.candidates`) / needs_input(`PHONE_INVALID_DIGITS`, `PICKUP_TOO_SOON`·`PICKUP_IN_PAST`·`PICKUP_INVALID_FORMAT`, `ADDRESS_NOT_FOUND`, `ADDRESS_REGION_NEEDED`(같은 주소가 여러 시군구에 있음 — needs에 `regions`·`heard`, 2026-11-05), `ITEM_UNSPECIFIED`, `NOTHING_TO_RECORD`, `RESULT_SUPERSEDED`). facts: recorded·changed·cleared·auto_selected(P6)·geo_missing·phones_to_read·readback(되읽기 gate가 열렸을 때 읽을 값, 발신번호·저장 상세주소 제외) |
| `find_destination` | name·place·detail·organization·department·recent(bool, 기본 false). 상세주소가 없다는 답은 detail에 빈 문자열 | needs_choice(이름표, 후보는 `state.candidates`; 1건이면 facts.guidance로 질문형 확인) / ok(`DEST_DEFERRED`: 후보를 찾았지만 발송지 처리 뒤 제시, facts.found 포함) / ok(일치하는 후보가 없으면 들은 받는 분 성함을 보존) / ok(`DEST_PICKED`: 이미 제시한 후보 중 1건으로 좁혀지면 그 핀을 바로 적용) / ok(`DEST_NEW_RECEIVER`: 실제 주소의 핀이 없으면 받는 곳 주소·성함·들은 상세 기록) / needs_input(`NOTHING_TO_RECORD`·`ADDRESS_REGION_NEEDED`·`DEST_NONE`·`DEST_TOO_MANY`·`RESULT_SUPERSEDED`) / unavailable(BE) |
| `lookup_orders` | receiver_name, other_customer, scope(optional: current_call·previous_call·selected) | ok(1건 → `state.selected_order`, 조회 상세 `facts.lookup_order`) / needs_choice(여러 건) / needs_input(`ORDER_NOT_FOUND_BY_NAME` 또는 `ORDER_SELECTION_REQUIRED`) / rejected(`ORDER_OTHER_CUSTOMER`: 다른 번호·다른 고객 접수, BE 호출 없음) / unavailable(`CALL_NOT_REGISTERED`). 조회 결과 facts에 `scope`(이 번호로 접수된 택배만) |
| `search_manual` | question | ok(answerable, context; `KB_NO_EVIDENCE`·`KB_LOW_SCORE`) / unavailable(`KB_UNAVAILABLE`·`KB_TIMEOUT`) |
| `get_state` | `include_values`(bool, 기본 false) | ok + 상태 요약(아무것도 바꾸지 않음). `include_values=true`면 `facts.current`(진행 중 택배의 검증된 값 `{value, from?}`, 발신번호 제외)·`facts.candidates`(제시 중인 받는 곳 후보의 이름표·성함·주소·상세주소·연락처). 기업 사원 후보·값의 연락처·상세주소는 넣지 않음 |

**서버 전용**(모델에 없음): `app/tools/cancel.py`의 `cancel_parcel`은 선택 택배 한 건, `cancel_order`는 같은 기존 주문 전체를 취소한다. 같은 주문의 취소 요청은 겹쳐 실행하지 않으며, 앞 시도가 불확실하면 해당 대상 상태를 다시 조회한다. 결과는 ok(done·`CANCEL_ALREADY`), rejected(`CANCEL_LOCKED`·`ORDER_OUT_OF_RANGE`), unknown(`CANCEL_OUTCOME_UNKNOWN`)이다. 현재 통화의 초안은 배송 초안 경로로 취소한다. 확인·후보 선택·용건은 발화 끝 Decision으로 판단한다.

**주소**(`app/integrations/address.py` + `app/address/`): (2026-11-09) 모델은 들은 문장을 한글 그대로 기본주소 필드에 넣고, 서버가 상세주소(동·호·층·건물 이름)를 떼어 `_detail`에 기록하며 수사를 숫자로 바꾼다(`parse.split_detail`·`detail_text`, `matcher.resolve_detail` — 수사가 붙어 경계가 여럿이면 실존하는 기본주소를 주소DB가 고르고, 둘 이상이면 ambiguous). 기본주소를 못 찾아도 뗀 상세는 기록하고(결정 1), 번호 뒤 이름은 상세로(결정 3). 뗀 상세는 고객이 말한 값이라 출처 CUSTOMER로 기록해 되읽기에 넣는다. 기본주소가 바뀌었는데 상세를 같이(문장 안이든 따로든) 말하지 않으면 이전 상세를 비우고 다시 묻는다(같은 도로의 번호 정정도 — 사용자 결정 2026-11-09). 도구 필드는 그대로다. 주소DB 보정은 전용 스레드풀, 예산 3초(도구 예산 3.5초 안). 장애·초과는 들은 값 그대로 + geo 없음. (2026-11-06) 접수용 지번·법정동·우편번호는 주소DB에서 만들고(`AddressDB.geo`, 카카오와 같은 표기) 비어 있을 때만 카카오 geocode. 카카오 키워드·similar 검색은 로컬이 못 찾았거나 약할 때만 두 번째 근거로(결과는 주소DB로 검증). 카카오는 공유 클라이언트 + 세마포어. (2026-11-12) 번호 없이 건물명·상호명으로 기본주소를 확정하면 기본주소에는 도로명주소를, 상세주소 앞에는 검색이 찾은 이름(주소DB 건물명·카카오 장소명)을 붙여 기록한다("국회의사당 3층", 상세주소가 없으면 이름만). 기본주소가 그 뒤 바뀌었거나 상세주소가 이미 그 이름으로 시작하면 붙이지 않는다. 도구 필드와 BE 계약은 그대로다.
작성일: 2026-11-03 · 근거: `tools/*.py`, `backend_client/order.py`, `address_resolver/`, `app/rag/text_agent.py`(당시 `tools/rag/`, 지금은 원본 경로)
표기: **[코드]** 구현 확인 · **[문서]** 문서만 · **확인 필요**

> 도구 이름·인수 스키마는 GPT-Live-1(또는 위임 모델)에 노출되는 **내부** 계약이다. BE 계약과 달리 재설계 시 바꿀 수 있지만,
> 바꾸면 페르소나 지시문(BE `promptText`, `docs/call-flow/voice.md`)과 함께 바꿔야 한다.

---

## 1. 공통 실행 규약

### 1.1 등록과 정의
- 등록: `@tool(name, description, args)` 데코레이터 → 전역 `TOOLS: dict[str, Tool]`. 이름 중복 시 `RuntimeError`. [코드] `tools/base.py:90-100`
- 등록 트리거: `tools/registry.py`가 5개 모듈을 import (부작용 import). [코드] `tools/registry.py:3`
- 함수 도구 정의: `TOOLS[name].spec()` → `{"type":"function","name","description","parameters","strict"}`. `openai.pydantic_function_tool`로 생성(strict JSON Schema). [코드] `tools/base.py:83-87`
- 인수 기반 클래스 `Args`: `extra="forbid"`, `strict=True` (모르는 키 거부, 타입 강제). [코드] `tools/base.py:15-18`

### 1.2 실행 `run_tool(ctx, name, arguments, call_id, allowed=None) -> dict` [코드 `tools/runner.py:23-52`]

순서: 도구 조회 → 인수 JSON 검증(`model_validate_json`, 빈 문자열은 `"{}"`) → `allowed` 확인 → `asyncio.wait_for(tool.run(ctx,args), timeout)` → 기록.

| 상황 | 결과 |
|---|---|
| 성공 | `{"ok": true, ...Result.data}` |
| `ToolError` | `{"ok": false, "error", "retry", ...e.data}` (부분 반영 데이터 포함 가능) |
| 없는 도구 | `ok:false`, `error:"없는 도구: {name}"` |
| 인수 검증 실패 | `ok:false`, `error:"인수 오류"`, `retry`=필드 경로·오류 타입 최대 5개 |
| 허용 목록 밖 | `ok:false`, `error:"지금 쓸 수 없는 도구: {name}"` (주의: **검증 뒤에** 허용 확인) |
| 시간 초과 | `ok:false`, `error:"처리 시간 초과"`, `retry:"잠시 후 한 번만 다시 시도"` |
| 기타 예외 | `ok:false`, `error:"내부 오류"`, `retry:"잠시 후 한 번만 다시 시도, 계속되면 상담원 전환 안내"` |

- 시간 제한: `search_manual`은 `ctx.rag_timeout_sec`(기본 12s), 나머지 `ctx.tool_timeout_sec`(기본 10s). [코드] `runner.py:39`
- 기록: `ctx.records[call_id]` = `{call_id,name,arguments,status(running|done|error),started,output,elapsed_ms}`. 개인정보 포함, 크기 제한·폐기 없음. [코드] `runner.py:26-51`, `context.py:34`
- **업무 실패와 시스템 실패를 구분하는 기계 판독 필드가 없다**: 둘 다 `ok:false` + 한국어 `error` 문자열. 일부 도구만 `outcome`/`status`를 추가.

### 1.3 `ToolContext` (통화 1건의 도구 상태) [코드 `tools/context.py`]

| 구분 | 필드 | 쓰는 도구 |
|---|---|---|
| 식별 | `session_id`, `caller`(SIP 정규화, 미신뢰), `call_session_seq`(BE 통화 번호) | 전 도구, lookup/cancel |
| 의존성 | `backend`(BackendAPI \| MockBackend, `Any`), `rag`(`async (question)->dict`) | match/lookup/cancel, search |
| 업무 상태 | `order: Order`(택배 1개), `pickup_at`, `customer_name`, `pins: list[Place]` | record, match |
| 설정 | `tool_timeout_sec=10`, `rag_timeout_sec=12`, `rag_min_score=None`, `kakao_timeout_sec=3`, `pin_recent_count=5`, `max_pin_options=3`, `lookup_limit=5` | — |
| 도구 산출물 | `pin_candidates`, `orders`, `running_ops`, `records` | match→서버, lookup→cancel, cancel |

- 여러 택배(`parcels[]`), 결제 방식, 통화 결과 키 등은 `ToolContext`에 없다(새 서버의 몫).

---

## 2. 도구별 계약

### 2.1 `record_order` [코드 `tools/record_order.py`, 인수 `tools/base.py:25-60`]

설명: 고객이 말한 택배 항목·수거 시각·전화 주신 분 성함 기록(정정 포함). 들은 항목만, 나머지 null.

인수 `OrderFields` (모두 optional, null 허용):

| 필드 | 타입·제약 | 서버 정규화 |
|---|---|---|
| `sender_name`, `receiver_name` | str ≤30 | strip |
| `sender_phone`, `receiver_phone` | str ≤40 ("들은 그대로, 한글 숫자 가능") | `normalize_phone`: 한글/고유어 숫자→숫자, `+82`→0, 15xx/16xx/18xx 8자리, `010`은 11자리, 기타 `0`시작 9~11자리. 실패 시 invalid |
| `sender_address`, `receiver_address` | str ≤120 | 주소DB 보정 + 카카오 지번 |
| `sender_address_detail`, `receiver_address_detail` | str ≤60 ("없다고 하면 빈 문자열") | strip |
| `document_count`, `small_box_count`, `medium_box_count`, `big_box_count` | int 0~99 | — |
| `other_item` | str ≤40 | strip |
| `item_price` | int 0~100,000,000 | — |
| `client_comment` | str ≤100 | strip |
| `pickup_at` | str ≤40, KST ISO 8601 | `future_time`: 시간대 필수 + 현재 이후, KST로 변환. 실패 시 invalid |
| `customer_name` | str ≤30 | strip |

처리:
1. `pickup_at`, `customer_name`은 `ctx`에, 나머지는 `ctx.order`에 기록. [`record_order.py:33-45`]
2. 주소가 **바뀌었고** 상세주소를 같이 말하지 않았으면 기존 상세주소를 `None`으로 지움. [`:37-43`]
3. 바뀐 주소마다 `resolve` (sender → receiver **순차**): [`:66-91`]
   - `address_resolver.correct()` → `not_found`: 주소·상세·geo 모두 지움, `retry:true`
   - `confirmed`/`ambiguous`: **둘 다 `candidates[0]`으로 덮어씀** (ambiguous도 1순위로 확정 기록 — §4 위험)
   - 보정 꺼짐(DB 없음): 들은 그대로, status `off`
   - 이후 `kakao.geocode()` → `Geo` 또는 None
4. 하나라도 invalid면 **나머지는 기록한 채로** `ToolError` 발생 (부분 반영).

결과 `data`:

| 키 | 의미 |
|---|---|
| `recorded` | 기록한 필드 이름 목록 |
| `changed` | 기존 값이 있었고 바뀐 필드(정정) |
| `phones_to_confirm` | `{필드: 정규화 번호}` 새로 받은 번호(되읽기 대상) |
| `addresses` | `{sender_address|receiver_address: {status: confirmed|ambiguous|not_found|off, changed, geo, retry}}` (주소 문자열 미포함) |
| `pickup_past` | (오류 시) 형식은 맞는데 지난 시각인지 |

오류: `"형식이 맞지 않아 기록하지 않음: {필드들}"` + `retry`(사람 말 안내) + 위 data / `"기록할 항목이 없음"`.

### 2.2 `match_pins` [코드 `tools/match_pins.py`, 매칭 `backend_client/order.py:140-198`]

인수 `MatchArgs`: `name`≤30, `place`≤80, `detail`≤40, `organization`≤80, `department`≤80 (모두 optional).

처리:
1. 공백 제거 후 빈 값 제외. 모두 비면 `ToolError("찾을 말이 없음")`.
2. 기업·부서가 없으면 개인 후보 `ctx.pins[:pin_recent_count]` → 없으면 전체 `ctx.pins`에서 `match_places`(이름·상세 포함 여부 + `place_score` 자모 편집거리 1 허용, 숫자 불일치 시 제외).
3. 못 찾았거나 기업·부서가 있으면 BE `search_company_places(query, limit=max_pin_options+1)`. query = organization·department·name·place·detail 공백 연결. 예외 시 `ToolError("기업 배송지 검색 장애")`.

결과 `status`:

| status | 조건 | 추가 키 |
|---|---|---|
| `one` | 후보 1개 | `found`, `labels` |
| `many` | 후보 2~`max_pin_options`개(초과분은 앞쪽만) | `found`, `labels` |
| `more` | 기업 검색 `hasNext` 또는 `total_count > max_pin_options` | `found` |
| `ask_place` / `ask_name` | 0건이며 이름만/장소만 말함 | `found:0` |
| `none` | 0건 | `found:0` |

- 후보 자체는 `ctx.pin_candidates`에만 저장, 모델에는 `pin_labels`(구별용 이름표)만 반환. 상세주소·연락처는 반환하지 않음.
- 주의: 개인 주소록에서 `many`로 잘린 경우에도 `found`는 전체 수.

### 2.3 `lookup_orders` [코드 `tools/lookup_orders.py`]

인수: `receiver_name` str ≤30 optional.
처리: `call_session_seq` 없으면 `ToolError("통화 번호 없음(고객 확인 실패)")` → BE `find_parcels(call_session_seq, lookup_limit)` → 성함 부분 일치 필터(공백·기호 제거 후 `in`).
결과: `{"found": n}` (택배 목록은 `ctx.orders`에만). 실패: `ToolError("조회 실패")`.
- 한계: 최근 `lookup_limit`(5)건 주문 안에서만 찾는다. [문서 `ai/backend-api.md` §2 shortcut]
- 모델은 개수만 받으므로 상태 안내·후보 선택에 필요한 값을 서버가 따로 제공해야 한다(현재 저장소에 없음).

### 2.4 `cancel_order` [코드 `tools/cancel_order.py`] — **서버 전용**

인수 `CancelArgs`: `order_seq` int 1~2147483647, `order_parcel_seq` 동일, `customer_confirmed` bool(필수), `operation_id` str ≤120(서버가 부여).

처리:
1. `customer_confirmed is not True` → `ToolError("고객 확인 없음")`.
2. `call_session_seq` 없음 → `outcome:"failed"`.
3. 같은 대상 이전 시도가 있으면 먼저 `parcel()` 조회 → 이미 `CANCELLED`면 `outcome:"done", already_done:true`.
4. `cancel_parcels()` → `ok`(204) → `outcome:"done"` / `not_found`(404) → `failed` / `conflict`(409) → 재조회 후 `already` 또는 `locked`.
5. 전송 중 예외·취소(타임아웃 포함, `BaseException`) → `running_ops[op].status="unknown"` 후 재발생.

결과 `outcome`: `done` | `already` | `locked` | `failed` (실패 계열은 `ToolError.data`로 전달).
- 주의: `ctx.orders`에 있는 대상인지 검증하지 않는다(BE의 `call_session_seq` 범위 검사에만 의존).
- 주의: 409 이후 재조회(`parcel`)가 실패하면 `ToolError`가 아니라 일반 예외 → runner의 "내부 오류"로 바뀌고 `outcome` 없음.
- 스키마상 모델 함수 도구로 노출 가능(`spec()` 제공). "서버만 부른다"는 규칙은 호출자가 `allowed`로 지켜야 한다.

### 2.5 `search_manual` [코드 `tools/search_manual.py`]

인수: `question` str 1~500.
처리: `ctx.rag` 없음 → `ToolError("매뉴얼 검색 미연결")`. `await ctx.rag(question)` 예외 → `ToolError("매뉴얼 검색 실패")`.
기대 RAG 반환 형태: `{"context": {"question","status","evidence":[{chunk_id,source_id,title,content,...}]}, "reranked":[{"reranker_score"}...], "timings":{...}}`.
결과: `{"context": SearchContext.llm_payload(), "answerable": bool, "timings": {...}}`.
- 실제 구현체는 `RagService.__call__`(`app/rag/service.py` `__call__`, `wait_for(to_thread(_search), 12s)`). `tools/context.py:21` 주석의 `RagService.answer`는 존재하지 않는다. runner의 12s `wait_for`와 **이중 타임아웃**.
- `answerable` = `status=="found"` 이고 (`rag_min_score` 없음 또는 점수 없음 또는 1등 점수 ≥ 임계값).
- 반환 형태가 다르면(KeyError) runner "내부 오류". RAG 세부 계약은 `current-state.md` §RAG.

### 2.6 중복 정의: `app/rag/text_agent.py`의 `search_manual`
- 같은 이름 `search_manual`의 별도 스키마(question ≤2000)와 Responses API 루프(`client.responses.create`, `max_rounds=3`)가 있다. 검색 함수 반환은 `result['tool_output']`을 기대 → `tools/search_manual.py`와 계약이 다르다. "텍스트 실험 루프, 전화 세션 미사용" [코드 docstring `text_agent.py:1`].

---

## 3. 원본에서 빠진 것(새 서버가 담당) [문서 `README.md` 도구 표]

| 도구 | 빠진 책임 |
|---|---|
| record_order | 주소록 유사 받는 곳 선확인, 정정·번호 확인 문구, 신규 고객 자동 등록(`create_customer`→`caller_context` 재호출→`create_pin`) |
| match_pins | 여러 턴 조건 합치기, 거절 후보 제외, `restart` |
| lookup/cancel/search | 흐름 사건(상태 전이) |
| (원본 전용) | `answer`, `switch_task`, `get_state`(흐름 엔진), `modify_order`(보류) 미이전 |

---

## 4. 현재 계약의 위험 (재설계 입력)

1. `record_order`가 `ambiguous` 주소를 1순위 후보로 **확정 기록**한다 → "검증되지 않은 정보를 확정하지 않는다"(AGENTS.md §6) 위반 소지. 호출자가 `addresses[*].status`를 반드시 확인해야 함.
2. 오류 결과에 기계 판독용 코드가 없음(`error`가 한국어 문장). 업무 오류/시스템 오류/재시도 가능 여부 구분 불가.
3. 부분 반영 후 `ok:false` → 모델이 "아무것도 기록되지 않았다"고 오해할 수 있음.
4. 허용 목록(`allowed`) 확인이 인수 검증 뒤 → 허용되지 않은 도구에 "인수 오류"가 먼저 나갈 수 있음.
5. `ToolContext`가 mutable dataclass로 도구 간 결과를 암묵 전달(`pin_candidates`, `orders`) — 동일 통화 내 도구 동시 실행 시 경합.
6. 도구 정의가 `openai` SDK(`pydantic_function_tool`)에 의존 → 도메인 계층이 SDK에 결합.
