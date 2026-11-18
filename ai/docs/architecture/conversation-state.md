# Conversation State (Business State) 설계 (v3)

> 구현(S2, 2026-11-03): `app/domain/`(state·assess·confirm·store·outcome·claims), 정책 `policy/workflow.toml`. 설계와 다른 점: 필드 상태 `CONFIRMED`는 두지 않고 보관소의 `confirmed_snapshot`으로 판단, `pending_confirmation`은 `ConversationState.pending`에 둠(도메인 관문이 순수 함수로 검사하게), `no_more_parcels` 추가(more_parcels 단계 완료), 결제·취소·상담원 확인(kind)은 S3·S5에서 같은 관문에 붙임, G6은 세션 계층(S5).

> v3: 서버는 다음 질문을 정하지 않는다. 절차는 Workflow Policy(`workflow-policy.md`)에 따라 Live가 진행하고, 서버는 `assess()`로 완료·누락·gate 개방만 판정한다.

상태: 설계안 · 업무 규칙 출처: `docs/call-flow/README.md` "반드시 지킬 것", `scenario.md`, BE 계약 `docs/contracts/be-api.md`

## 1. 원칙

1. 서버 상태가 유일한 근거다. 되읽기·접수는 상태에 기록된 값으로만 한다(`call-flow/README.md` §3).
2. 값에는 **출처·검증 상태·필드 버전**이 붙는다. 검증되지 않은 값은 확정·접수에 쓰지 않는다.
3. 상태는 `domain/` 순수 객체다(SDK·HTTP 의존 없음). 변경은 `CallSession.lock` 안의 짧은 동기 구간에서만 한다(`concurrency.md` §3).
4. 모든 변경은 `state_version`을 1 올리고, 바뀐 필드의 `version`을 그 값으로 기록한다. 외부 작업 결과·확인의 신선도는 **필드 버전**으로 판단한다.

## 2. 핵심 데이터 구조

```python
class FieldStatus(StrEnum):
    EMPTY = "empty"                    # 아직 못 들음
    VALID = "valid"                    # 서버 검증 통과(형식·주소DB 확정)
    PENDING_CHOICE = "pending_choice"  # 후보 중 선택 필요(ambiguous 주소, 여러 핀)
    INVALID = "invalid"                # 형식 오류 — 값 저장 안 함, 재질문 대상
    CONFIRMED = "confirmed"            # 택배 담기 확인 완료

class Source(StrEnum):
    CUSTOMER = "customer"; CALLER_ID = "caller_id"; PROFILE = "profile"
    HISTORY = "history"; PIN = "pin"; COMPANY = "company"; RESOLVER = "resolver"

@dataclass
class FieldState(Generic[T]):
    value: T | None = None
    status: FieldStatus = FieldStatus.EMPTY
    source: Source | None = None
    version: int = 0                      # 마지막 변경 시점의 state_version
    candidates: tuple[str, ...] = ()      # PENDING_CHOICE일 때 이름표
    attempts: int = 0                     # 재질문 횟수
    needs_readback: bool = False          # 고객이 새로 불러 준 전화번호
    previous: T | None = None             # 직전 값(정정 안내·로그용)

@dataclass
class ParcelDraft:                         # 받는 중인 택배 1개 (기존 Order 대응)
    sender_name, sender_phone, sender_address, sender_address_detail: FieldState
    receiver_name, receiver_phone, receiver_address, receiver_address_detail: FieldState
    items: FieldState[ItemSpec]
    item_price: FieldState[int]
    client_comment: FieldState[str]
    sender_geo, receiver_geo: Geo | None   # 주소 VALID일 때만
    destination_ref: DestinationRef | None # 핀/기업 후보에서 고른 경우(기업 → originPin 미지정)

@dataclass
class ConversationState:
    intent: Intent | None                  # order | lookup | cancel | inquiry | agent | end
    customer: CustomerContext              # 1·2단계 고객 확인 결과
    call_session_seq: int | None
    current: ParcelDraft | None
    parcels: ParcelStore                   # 담은 택배(접수 전까지 수정 가능, P5) — current와 분리된 통화별 임시 보관소
    pickup_at: FieldState[str]             # 통화당 1개
    payment: FieldState[PaymentMethod]     # 통화당 1개
    candidates: CandidateSet | None        # 받는 곳/주문 후보(서버 보관, 모델·Decision엔 이름표만)
    selected_order: ParcelRef | None       # 취소 대상
    stage: str                             # assess()가 판정한 현재 정책 단계(Decision 맥락 항목·질문 세트의 원천)
    live_known_version: int                # Live에 마지막으로 전달한 state_version(인지 차이 판단)
    unanswered: list[UnansweredQuestion]
    counters: Counters

@dataclass
class StoredParcel:
    parcel_id: str                 # 통화 내 짧은 ID(이름표: "첫 번째 택배, 이영희 님께")
    draft: ParcelDraft             # 필드·검증 상태·필드 버전 그대로 유지
    confirmed_snapshot: dict | None  # 마지막으로 고객이 확인한 내용(P5 후속 B안: 미확인 수정 중 종료 시 이것을 전송)
    confirmed_hash: str | None     # confirmed_snapshot 해시. 현재 내용 해시와 다르면 수정 중(미확인)

class ParcelStore:                 # P5: 접수 전까지 통화 안에서 수정 가능
    items: list[StoredParcel]
    def add_confirmed(self, draft, snapshot_hash) -> str
    def open_for_edit(self, parcel_id) -> ParcelDraft        # current로 꺼내 수정(confirmed_snapshot은 유지)
    def pending_reconfirm(self) -> list[str]                 # 수정 후 아직 재확인 안 된 parcel_id
    def snapshot_for_submit(self) -> list[dict]              # 확인된 항목은 현재 내용, 수정 중 항목은 confirmed_snapshot

@dataclass(frozen=True)
class PendingConfirmation:                 # CallSession.pending_confirmation
    id: str                    # 짧은 ID — 이 확인을 위해 부른 Decision 결과를 묶는 이름표
    kind: Literal["parcel", "payment", "cancel", "agent"]
    snapshot: dict             # 되읽은 값 그대로(담기·취소 실행의 입력)
    snapshot_hash: str         # 정규화한 snapshot의 해시
    field_versions: dict[str, int]  # 확인 대상 필드 → 버전
    asked_version: int         # 발급 시 state_version (관측용)
    issued_t: float            # 발급 시각(서버 수신 시계). 되읽기 발화가 이 뒤에 시작돼야 한다(G3)
```

v1의 1회용 확인 토큰은 두지 않는다. `id`는 Decision 결과를 확인 대상에 묶는 이름표일 뿐 모델에 노출하지 않는다.

## 3. 필드 상태 전이

```
EMPTY ──record──▶ (서버 검증)
          ├─ 형식 OK ───────────────────────▶ VALID
          ├─ 주소 confirmed ────────────────▶ VALID (보정 주소, geo 부착 시도)
          ├─ 주소 ambiguous ─────────────────▶ VALID (1순위 자동 확정, auto_selected=true, 나머지 후보 보관 — P6)
          ├─ 핀 여러 개 ────────────────────▶ PENDING_CHOICE ──Decision pick──▶ VALID
          │                                                  └─pick=none──▶ EMPTY(attempts+1)
          ├─ 주소 not_found / 전화 자릿수 / 지난 시각 ─▶ INVALID(값 없음, attempts+1)
          └─ 보정 서비스 장애 ───────────────▶ VALID(source=CUSTOMER, geo=None) + 결과 INCOMPLETE 사유
VALID ──record(다른 값)──▶ 검증 성공 시 교체(previous 보관, version 갱신) → 관련 pending_confirmation 무효
VALID ──담기 확인──▶ CONFIRMED (ParcelStore에 보관, confirmed_hash 기록)
CONFIRMED ──고객이 담은 택배 수정 요청──▶ current로 꺼냄(open_for_edit) → 값 수정 → 다시 되읽기·확인
```
- ambiguous 주소는 **1순위로 자동 확정**한다(P6, 기존 `record_order.py:83-84` 동작 유지). 결과에 `auto_selected=true`와 다른 후보를 보관하고, 고객이 나중에 정정하면 일반 정정 경로로 바꾼다.
- 수거 시각은 시간대 포함, **현재 시각 + 1시간 이후**만 VALID(P1). 미달이면 INVALID `PICKUP_TOO_SOON`.
- 주소가 바뀌면 같은 쪽 상세주소·geo를 EMPTY로(결과 `facts.cleared`로 명시).
- 보내는 분 연락처는 발신번호(`Source.CALLER_ID`), 묻지도 읽지도 않는다.

## 4. 정정 발화 처리

| 상황 | 처리 |
|---|---|
| VALID 값을 다르게 말함 | Live 위임 → Backend `record_fields` → 검증 성공 시 교체, `facts.changed` |
| 정정 값이 검증 실패 | **기존 값 유지**, `needs_input` + `code`(잘못 들은 정정으로 맞는 값을 잃지 않게) |
| 확인 대기 중 "아니요, 이름이…" | Decision `confirm=change`/`no` → pending 즉시 폐기(잠금 구간) → 값은 위임 경로로 기록 → `readback_ready`가 다시 참이 되면 새 확인 내용 전달. 원본 사고 11-01 23:14 유형 |
| 확인 대기 중 값만 말함(Decision이 확인 답으로 보지 않음) | 위임 경로로 기록 → 확인 대상 필드 버전 변경 → pending 자동 무효(§5 G2) |
| 순서 밖 값 | 버리지 않고 기록. `missing`은 고정 순서대로 정렬해 Live가 순서를 이어가게 함 |
| 담은 택배 수정(P5) | 고객이 담은 택배를 고치려 함 → 택배가 여러 개면 Decision `pick`(택배 이름표 중 선택), 하나면 바로 → `ParcelStore.open_for_edit` → 값은 위임 경로로 수정 → 다시 되읽기·확인. 진행 중이던 택배가 있으면 그 택배는 보관소에 미확인으로 잠시 보관 |

## 5. 주문 확인과 확정

### 5.1 확인 요청 (gate 단계 개방)
```
assess(state).readback_ready == True   (현재 택배 필수 필드 전부 VALID, missing=[])
  잠금: PendingConfirmation{id, kind, snapshot=VALID 값들, snapshot_hash, field_versions} 설정
  잠금 밖: 확인 내용(읽어도 되는 형태의 값)을 Live에 전달
           - 직전이 위임(값 기록)이면 그 결과에 포함(N1), 아니면 thinking.append(N1')
           이후 고객 발화 끝의 Decision 호출에 confirm 질문을 넣는다(pending이 있는 동안만, `delegation.md` §3.2)
Live가 정책에 따라 되읽기 → 고객 답 → 발화 끝(0.8초) → Decision(직전 AI 발화 + 고객 발화)
```
- Live가 확인 내용 없이 되읽기를 시작해도 감지하지 않는다: pending이 없으면 confirm 질문을 넣지 않으므로 고객의 "네"는 확정으로 이어지지 않는다(`delegation.md` §7.4, S0b에서 출력 감시 실패).
- 서버는 Live가 실제로 읽은 문장을 검증하지 않는다(스냅샷은 서버가 준 값). Live가 다른 값을 읽었는지 의심되면(고객이 "아니요, 그게 아니라…") 정정 경로로 처리된다.

### 5.2 확정 관문 (Decision `confirm@{id}=yes` 수신 시)

| 검사 | 내용 |
|---|---|
| G1 대상 일치 | 그 Decision 호출에 묶인 `pending_confirmation.id` == 현재 pending, 이 확인이 아직 `done` 아님, 그 발화보다 최신 발화의 결과를 아직 적용하지 않음 |
| G2 스냅샷 일치 | 현재 확인 대상 필드의 버전 == `field_versions` **그리고** 현재 값 해시 == `snapshot_hash` |
| G3 들은 뒤의 답 | Decision 입력에 쓴 **직전 AI 발화**가 `issued_t` 뒤에 시작했고(서버가 확인 내용을 준 뒤의 되읽기), 고객 발화의 `start_ms` ≥ 그 AI 발화의 `end_ms` − 허용오차(끝까지 듣기 전 "네" 방지, 원본 11-02 사고) |
| G4 신뢰도 | `confirm`의 `yes` 확률 ≥ θ_yes (`change` 확률이 θ_change 이상이면 통과 안 함) |
| G6 복합 발화 | 같은 발화 구간에 위임이 있으면 그 위임 완료 후 G2 재검사(`delegation.md` §4.1 R2) |
| G5 통화 상태 | `closed=False`, phase=ACTIVE |

통과 → `commit_delay_ms`(기본 700) 타이머. 그동안 새 입력 전사가 오면 취소(새 Decision을 기다림). 만료 시 잠금 안에서 **G1·G2를 다시 검사**하고 실행.

| kind | 실행 | 외부 부작용 |
|---|---|---|
| parcel | `ParcelStore.add_confirmed`(수정 중이던 택배면 같은 항목 갱신), current 초기화 | 없음(BE 전송은 통화 끝 1회) |
| payment | `payment` CONFIRMED | 없음 |
| cancel | `ops["cancel:{o}:{p}"]`로 BE 취소(`concurrency.md` §5) | 있음 |
| agent | `ops["refer"]`로 refer | 있음 |

- `no` → 즉시 pending 폐기(거절은 확정 지연 없이). `not_answer`/임계 미만 → 아무것도 하지 않음(Live가 대화로 다시 확인), `attempts`+1, 3회면 상담원 제안.
- 중복 확정 요청(같은 확인에 yes 두 번): G1에서 `done`이면 무시.
- 통화 종료(`closed`) 중 확정 대기: 버린다(`scenario.md` "확정 지연 중 끊기면 실행하지 않음").
- 취소 요청(고객이 담기 자체를 취소): Decision `switch=cancel`이면서 확인 대기 중이면 pending 폐기 후 의도 확인.

### 5.3 주문 생성(통화 결과)의 중복 방지
- 주문 생성은 통화 끝 `POST /api/orders` 1회(`call-flow/README.md` §3). 통화 중 "담기"는 내부 상태라 Lock·버전으로 충분하다.
- 전송은 아웃박스(`call-lifecycle.md` §7): 통화당 1행(PK=call_id), `Idempotency-Key`와 본문을 **전송 전에 영속**, 본문과 함께 `ParcelStore.snapshot_for_submit()` 해시 저장. 재시도·재시작에도 같은 키·같은 본문. 본문은 **전송 직전(마무리 시점) 1회** 만들고 그 뒤로는 수정을 받지 않는다(P5 "접수 전까지"의 경계). 전송 직전 보관소 해시가 저장값과 다르면 전송하지 않고 경보.
- BE: 같은 키 재요청은 기존 결과 반환, 같은 통화에 다른 키는 409(`be-api.md` §8) → 이중 주문은 BE에서도 막힌다.

## 6. 업무 판정 `assess(state, policy) -> Assessment`

순수 함수. 질문 순서를 정하지 않고 **사실만** 판정한다.

```python
@dataclass(frozen=True)
class Assessment:
    stage: str                       # 정책 단계 중 첫 미완료 단계(받는 순서 고정 규칙 반영)
    stages: dict[str, StageStatus]   # 단계별 complete·missing·blocked
    readback_ready: bool             # 현재 택배 필수 전부 VALID
    payment_choice_needed: bool      # 결제 자격 2개 이상
    payment_auto: PaymentMethod | None   # 자격 1개면 그것, 없으면 billing
    attempts_exceeded: list[str]     # 정책 reask.max_attempts 초과 필드 → 다른 방법·상담원 제안 사실
    outcome_if_end_now: Outcome      # 지금 끊기면 보낼 결과(§7)
```

- 도구 결과·전달 내용(`delegation.md` §6.1)은 Assessment에서 파생: `fields`(필드별 상태), `missing`, `stage.complete`, `can_proceed`(gate 개방 여부), `needs`(INVALID·PENDING_CHOICE 필드와 사유 코드).
- 발화 끝 Decision 호출에 넣을 질문 세트는 현재 단계로 정한다(Live 세션 설정은 바꾸지 않는다, `delegation.md` §3.2).
- 받는 순서(보내는 분 성함 → … → 수거 일시)는 정책 파일의 `order`로 Live 지시문에 들어가고, `stage`/`missing` 계산에도 같은 순서를 쓴다.

## 7. 통화 결과 결정 (BE `POST /api/orders`)

| 상황 | outcome | 본문 |
|---|---|---|
| 업무 의도 없음(무의미) | **전송 안 함** | — |
| 문의·조회만, 주문 정보 없음 | INCOMPLETE (빈 결과 → BE NO_ORDER) | call + 고객 |
| 담은 택배 ≥1, `snapshot_for_submit()`이 COMPLETE 필수값 충족 | COMPLETE | 확인된 항목은 현재 내용, **수정 중(미확인) 항목은 마지막 확인 스냅샷**(P5 후속 B안, `decisions.md`) |
| 담은 택배 ≥1이나 일부 필수값(geo·배송비 등) 없음 | INCOMPLETE | 보관소 + 아는 값만 |
| 담은 택배 0, current 일부 수집 | INCOMPLETE | current의 VALID 값만 |
| 상담원 이관 | INCOMPLETE | 보관소 + current |
| 고객이 접수 취소 의사 | CANCELLED | 아는 값 |

- 본문은 기존 `result_body`/`parcel_body`(계약 불변). VALID/CONFIRMED 값만, 결제 방식 모르면 생략, 좌표 없음.
- 결과 `data.status`로 마무리: `ACCEPTED`→END_ACCEPTED(+`parcelNo`), `notPaid`→END_NOT_PAID, 그 외/불확실→END_PENDING. HTTP 201만으로 성공 안내 금지.

## 8. 대화 컨텍스트와 서버 상태의 일관성

| 위험 | 대책 |
|---|---|
| 모델 기억과 서버 값 불일치 | 도구 결과·전달 내용에 `fields`·`missing` 요약, 되읽기 값은 서버 확인 내용에서만. `live_known_version`이 뒤처지면 N1' 1회 |
| 컨텍스트 압축 | Backend는 필요 시 `get_state`. `usage_ratio` 0.8 경고 |
| Decision과 위임의 판단이 다름(예: Decision=확인 답, Live=값 위임) | 행동 소유자 분리(`delegation.md` §2): Decision은 확인만, 위임은 값만 → 둘 다 반영되어도 충돌하지 않고, 값이 바뀌면 G2로 확인이 무효 |
| 서버만 아는 사건 | `session.thinking.append`(무음) 1회, 상태에 반영되어 다음 결과에 나타남 |
| 개인정보 | 로그·지표에는 필드 이름·상태·버전만. 값은 메모리에만, 종료 후 폐기 |
