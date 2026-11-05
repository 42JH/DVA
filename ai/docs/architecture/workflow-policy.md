# Workflow Policy와 Business State (v3)

상태: 설계안 · 근거 표기는 `overview.md` §0 · 업무 규칙 출처: `docs/call-flow/README.md` "반드시 지킬 것", `scenario.md`

## 2026-11-05 구현: 입력 제한의 단일 출처

현재 실행 기준은 `policy/workflow.toml`이다. `[input_limits]`에서 물품 가액 1~100,000,000원(1억 원 포함), 접수 묶음별 소형·중형·대형 박스 합계 최대 10개, 서류 별도 최대 100개를 정의한다. `[phone]`은 기존 전화번호 정규화 후 허용 형식, `[pickup]`은 최소 준비 시간·영업시간·현재부터 최대 일수를 정의한다. 아래 v3 설계 예시보다 실제 TOML과 구현이 우선한다.

- `render_input_rules(policy)`가 같은 제한을 Live·Responses 지시문에 넣는다. business_rules.md의 수거 안내도 같은 정책으로 치환한다.
- `record_args(policy)`는 정책으로 도구 인자 모델을 생성한다. 세션의 Responses 스키마와 `run_tool`의 실제 검증이 같은 생성 함수를 사용한다. 모델은 정책별로 캐시하며 정책이 다르면 서로 섞이지 않는다.
- 수량 필드 각각의 상한은 스키마에, 박스 3종의 합계 제한은 서버 모델 검증에 적용한다. 합계는 JSON Schema의 개별 maximum만으로 표현할 수 없어 설명에도 명시한다. 유효하지 않은 호출은 기존 `TOOL_ARGS_INVALID`로 거절하고 기존 기록을 보존한다. 이 단계의 인자 검증 실패는 호출 전체를 거절하므로, 혼합 발화는 Responses가 정상 정보만 골라 보내도록 지시한다.
- 수량의 단위는 현재 받는 곳별 접수 묶음(`parcel`)이다. 여러 묶음을 같은 수령인·주소라는 이유만으로 자동 병합하거나 합산하지 않는다. 수령지 기준 통화 전체 합산은 식별 기준을 정한 뒤 별도로 구현해야 한다.
- `normalize_phone`은 실제 통화 정책의 전화번호 규칙을 사용한다. 기존 한글 숫자·+82·유선·대표번호 지원은 유지한다.
- 수거 상한은 날짜 비교 대신 **현재부터 정확히 3일(72시간)** 비교다. 09~17시 제한은 유지한다. 기본 시각은 초·마이크로초까지 올림해 최소 준비 시간 아래로 내려가지 않게 한다.
- Live는 명백한 가액·수량·전화번호 오류를 도구 거절 전에 설명·재질문할 수 있다. 정상 값 기록·저장 성공·최종 확정의 판단은 계속 서버 검증을 거친다. 시각 변경은 서버의 현재 시각으로 최종 검사한다.
- 설정 변경은 배포·재기동 뒤 새 통화에 적용한다. 실행 중 정책 파일 자동 재로딩은 추가하지 않았다. 실제 운영 페르소나의 중복 지시 정리와 상대 시각 기준 갱신, FAQ 분기 및 업무 전환 수정은 별도 과제다.

BE API 경로·요청/응답 필드·인증·주문 매핑은 유지한다. 도구의 입력 허용 범위만 사용자 확정 규칙에 맞춰 변경했다. `test_input_policy.py`는 정책 파일의 숫자를 실제로 바꿔 생성 프롬프트·세션 스키마·실행기·전화번호·수거 검사의 일치를 확인한다.

## 1. 두 개념의 분리

| | Workflow Policy | Business State |
|---|---|---|
| 정의 | 상담 절차: 단계·목표·필수 정보·완료 조건·진입 조건·재질문·예외·금지 행동 | 실제 업무 값: 수집 값·필드 검증 상태·현재 단계·확인 상태·Tool 결과 |
| 소유 | 저장소의 정책 파일 1개(버전 관리) | 서버(`CallSession.state`) |
| 사용처 | ① Live `instructions`로 렌더링(통화 시작 시 1회, F1 불변). **P2: BE 페르소나 `promptText`가 우선**이며 정책 렌더링은 그 뒤에 붙는 보조 절차 안내. `promptText`를 불러오지 못하면 서버 기본 프롬프트(`policy/default_prompt`)를 쓴다 ② Backend `instructions` 일부 ③ 서버의 단계 판정·관문 검사 ④ Decision 질문 문구 | 서버만 변경. Live에는 필요한 사실만 전달 |
| 변경 | 배포 단위 | 통화 중 매 업무 이벤트 |

**같은 정책 파일에서 Live 지시문과 서버 판정 규칙을 함께 만든다.** 이것이 "Live가 아는 절차"와 "서버가 검사하는 절차"가 어긋나지 않게 하는 핵심이다.

## 2. Workflow Policy 구조 (`policy/workflow.toml`, 예시)

> 구현(S2): 실제 파일은 `policy/workflow.toml`, 로더 `app/policy/model.py`(정합성 검사), 렌더러 `app/policy/render.py`, 기본 프롬프트 `policy/default_prompt.md`(`voice.md`의 페르소나·응대 규칙에서 옛 "[진행 상태]" 장치 문장을 뺀 것). 예시와 다른 점: 필드 목록 `[fields.*]`(label·kind·scope), 단계 `enter_when`·`exit_when`·`skip_if_valid`는 두지 않음(판정은 `assess` 코드), `[confirm]` 임계값, `[[forbid.claims]]`, `[[decision.<세트>.questions]]`(Decision 질문 문구), `edit_parcel`은 단계가 아니라 `switch=edit_parcel` + 보관소 동작.

```toml
version = "2026-11-03.1"

[[stage]]
id = "intent"                       # 업무 파악
goal = "고객의 용건(접수·조회·취소·문의·상담원)을 파악한다"
exit_when = "intent_known"

[[stage]]
id = "sender"
goal = "보내는 분 정보를 받는다"
enter_when = "intent == order"
required = ["sender_name", "sender_address", "sender_address_detail"]   # sender_phone은 발신번호로 채움
order = ["sender_name", "sender_address", "sender_address_detail"]
skip_if_valid = true                # 이미 기록된 항목은 다시 묻지 않는다
complete_when = "all_required_valid"

[[stage]]
id = "receiver"
required = ["receiver_name", "receiver_phone", "receiver_address", "receiver_address_detail"]

[[stage]]
id = "item"
required = ["items", "item_price"]

[[stage]]
id = "pickup"
required = ["pickup_at"]
rule = "고객 희망 시각. 현재 시각으로부터 최소 1시간 이후"   # P1, 서버가 검증(PICKUP_TOO_SOON)

[[stage]]
id = "readback"
goal = "서버가 준 확인 내용을 그대로 읽고 맞는지 묻는다"
enter_when = "server.readback_ready"   # 서버가 확인 내용을 줄 때만
gate = "server"                     # 이 단계의 완료는 서버만 판정

[[stage]]
id = "more_parcels"
goal = "더 보낼 택배가 있는지 묻는다. 담은 택배는 접수 전까지 고객 요청 시 수정할 수 있다"   # P5
[[stage]]
id = "edit_parcel"                  # P5: 담은 택배 수정
enter_when = "customer_requests_edit"
goal = "어느 택배를 고칠지 확인하고, 고친 뒤 다시 되읽어 확인받는다"
gate = "server"
# payment 단계 삭제(2026-11-05): 결제 방식은 묻지 않고 서버가 정한다(app/domain/assess.auto_payment)
[[stage]]
id = "closing"
gate = "server"                     # 마무리 문구는 서버가 준 접수 결과로만

[reask]
max_attempts = 3                    # 같은 항목 3회 실패 → 다른 방법 제안 → 상담원 제안
vary_wording = true

[agent]                             # P11: 미정 — 설정값으로 주입, 비어 있으면 상담원 제안 대신 "담당자가 확인 후 연락"
target_uri = ""                     # 운영 설정에서 덮어씀
open_hour = ""
close_hour = ""

[address]
ambiguous = "auto_select_top"       # P6: 1순위 자동 확정, 이후 정정 가능

[forbid]                            # Live 금지 행동(지시문으로 렌더링)
items = [
  "서버가 확인하지 않은 주소·전화번호를 확정된 것처럼 말하기",
  "접수 완료·취소 완료·요금·조회 결과를 서버 결과 없이 말하기",
  "서버가 확인 내용을 주기 전에 주문 내용을 되읽거나 확정 질문하기",
  "발신번호와 저장된 번호·상세주소를 소리 내어 읽기",
  "스스로 통화 종료하기",
]
# 서버 결정적 문구 검사(delegation.md §6.2-5): 출력 발화에 있고 서버 상태에 그 결과가 없으면 N3. 정상 안내에도 쓰는 말은 넣지 않는다
claims = [
  { phrase = ["접수되었", "접수됐", "접수 완료"], unless = "result_accepted" },
  { phrase = ["취소되었", "취소됐", "취소 완료"], unless = "cancel_done" },
  { phrase = ["결제되었", "결제됐", "결제 완료"], unless = "never" },
]

[speech]                            # 읽는 규칙(docs/call-flow/README.md §5). P8: 지금은 사실·금지 표현만, 추후 scripts 표로 정형 문구 추가 가능
phone = "고객이 불러 준 번호만 끊어 읽는다"
address = "시·구와 도로명·건물번호로 읽는다"
```

- 필드 이름은 Business State·BE 매핑과 같다(`backend_client/order.py` `ORDER_FIELDS`).
- 단계마다 `decision = "intent" | "collect" | "confirm" | "pick" | "pay" | "off"`로 서버가 발화 끝 Decision 호출에 넣을 질문 세트를 지정한다(`delegation.md` §3.2). `confirm`은 `pending_confirmation`이 있을 때만 들어간다. 같은 파일에서 Live 지시문의 위임 규칙("이 단계의 선택형 답은 위임하지 않는다", "자유형 값은 위임한다")도 생성해, Decision과 Backend가 같은 판단을 하지 않게 한다.
- 필드마다 `kind = "free" | "choice"`를 둔다. `free`는 Backend 추출 대상, `choice`(예: 결제 방식, 박스 규격 선택 질문)는 Decision 질문 대상.
- `gate = "server"` 단계는 Live가 스스로 진입·완료할 수 없다.

## 3. Business State 구조

`conversation-state.md` §2의 `ConversationState`·`FieldState`를 그대로 쓴다. v3에서 추가·변경되는 것:

```python
@dataclass
class StageStatus:
    stage: str                    # policy stage id
    complete: bool                # 서버 판정
    missing: list[str]            # 필수인데 VALID 아님
    blocked: list[str]            # INVALID·PENDING_CHOICE (사유 코드 포함)

def assess(state: ConversationState, policy: Policy) -> Assessment:
    """순수 함수. 현재 단계, 단계별 완료 여부, 누락·차단 필드, readback_ready, 결과 outcome 후보."""
```
- v2의 `next_step`(다음 질문 결정)은 없앤다. 서버는 **무엇이 끝났고 무엇이 빠졌는지**만 판정하고, 무엇을 어떻게 물을지는 Live가 정책에 따라 정한다.

## 4. Live 자율 범위와 서버 검증 경계

| 구분 | 행동 | 서버 관여 |
|---|---|---|
| **Live 자율(승인 없음)** | 인사·맞장구·대기 응답, 일반 질문 응답(정책 범위 안의 안내), 현재 단계 질문의 표현·순서 내 진행, 재질문·표현 바꾸기, 고객 끼어들기 응대, 받은 사실 재설명 | 없음 |
| **Live 자율 + 서버 기록(비동기)** | 고객이 값을 말하면 위임(값 기록) | 검증 결과만 돌려줌. Live는 결과를 기다리는 동안 다음 질문으로 넘어가도 된다(같은 단계 안) |
| **서버 판정 필수** | 주소 유효성, 전화번호 자릿수, 수거 시각, 단계 완료, readback 진입, 주문 최종 확인, 결제 방식 확정, 조회 결과, 취소, 상담원 전환, 통화 종료와 접수 결과 | 서버 결과 없이는 Live가 그 사실을 말하거나 다음 gate 단계로 넘어가지 않음 |

경계 규칙 한 줄: **말하는 것은 Live가 자유롭게, 업무 사실을 "확정"으로 말하는 것과 gate 단계 진입은 서버 결과가 있을 때만.**

## 5. 필수 절차 누락 방지 (다층 보장)

| 층 | 장치 | 성격 |
|---|---|---|
| 1 정책 지시 | Live instructions에 단계·필수 정보·금지 행동(P2로 페르소나 `promptText`가 우선하므로 페르소나가 절차를 빠뜨리면 약해짐 → 아래 하드 층이 보완) | 소프트(모델 준수율) |
| 2 서버 사실 전달 | 값 기록 결과에 `missing`·`stage_complete` 포함 → Live가 빠진 항목을 안다 | 소프트 |
| 3 gate 단계 | readback은 서버가 `readback_ready` + 확인 내용(스냅샷)을 줄 때만 가능. 서버는 `missing`이 비어야 준다 | **하드** |
| 4 확정 관문 | 고객 "예"가 와도 스냅샷·필드 버전·필수 완료를 서버가 재검사(`conversation-state.md` §5) | **하드** |
| 5 결과 문구 검사 | 서버가 출력 발화에서 고위험 업무 결과 문구(`[forbid].claims`)를 찾고 서버 상태에 그 결과가 없으면 N3(다음 턴 정정). LLM 판정 없음 — 출력 전사 Decision 감시는 S0·S0b에서 실패해 쓰지 않는다 | 감지·교정(좁음) |
| 6 최종 전송 | COMPLETE는 필수값 완비 시에만, 아니면 INCOMPLETE. BE도 422로 검증(`be-api.md` §8) | **하드** |

결과: 모델이 절차를 건너뛰어도 **업무 결과(택배 담기·주문 생성·취소)는 누락된 상태로 확정되지 않는다**. 대화상 누락은 층 2로, 고위험 결과 오안내는 층 5로 바로잡는다. 조기 되읽기는 감지하지 않고 층 3·4가 확정을 막는다.
