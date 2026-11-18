# CallSession · Lock · 다중 통화 설계

상태: 설계안 · 근거 표기는 `overview.md` §0

## 1. 실행 모델

- **단일 프로세스, 단일 asyncio 이벤트 루프.** 통화마다 프로세스·OS 스레드를 만들지 않는다.
- 통화당 장기 실행 태스크는 **sideband 수신 태스크 1개**뿐이다. 이벤트를 순서대로 읽고 핸들러를 직접 호출한다. 처리 큐·Actor는 두지 않는다.
- 외부 I/O(BE, 주소, RAG, 카카오)는 핸들러가 짧은 태스크로 띄우고 `CallSession.tasks`에 등록한다(종료 시 일괄 취소).
- 핸들러 자체는 "검사 → 상태 변경 → 송신할 명령 계산"만 하고 빠르게 반환한다. 수신 루프를 막지 않는다.

## 2. CallSession 데이터 구조

```python
@dataclass
class CallSession:
    # 식별
    call_id: str                     # = OpenAI session_id (BE providerCallId)
    trace_id: str
    caller: str | None               # SIP From 정규화(미신뢰)
    incoming_at: str                 # 최초 created_at ISO(재계산 금지)
    # 업무 상태
    phase: Phase                     # RECEIVED·ACCEPTING·ACTIVE·CLOSING·CLOSED·FINALIZING
    state: ConversationState         # 주문·고객·후보·ParcelStore(담은 택배, P5) (conversation-state.md)
    state_version: int               # 상태 변경마다 +1 (전체)
    # 동시성
    lock: asyncio.Lock               # 짧은 임계 구역 전용
    pending_confirmation: PendingConfirmation | None
    ops: dict[str, OpRecord]         # 진행·완료 작업: op_key → {status, started_version, result}
    tool_results: dict[str, str]     # 함수 call_id → 보낸 output (중복 수신 방어, 상한 200)
    decision: DecisionCursor         # 현재 질문 세트 ID, 적용한 마지막 source 시각
    transcript: TranscriptClock      # 마지막 고객 발화 end_ms, AI 발화 진행 여부·마지막 end_ms
    # 생명주기
    closed: bool                     # True 이후 모든 상태 반영·외부 부작용 금지(결과 전송만 예외)
    tasks: set[asyncio.Task]
    sideband: AsyncSidebandConnection | None
    timers: dict[str, asyncio.TimerHandle]

@dataclass
class OpRecord:
    key: str            # 예: "cancel:{order_seq}:{parcel_seq}", "address:receiver:v{field_version}", "stage2"
    kind: Literal["read", "internal", "external_side_effect"]
    status: Literal["running", "done", "failed", "unknown", "stale"]
    deps: dict[str, int]  # 시작 시 읽은 필드 → 필드 버전
    started_at: float
```

메모리: 통화당 수 KB~수십 KB(전사 텍스트 버퍼 상한 포함). 전사 원문은 최근 N개 발화만 보관하고 통화 종료 시 폐기.

## 3. Lock과 상태 버전

### 3.1 패턴: 검사·예약 → 잠금 밖 I/O → 검증·반영

```python
async def run_external(s: CallSession, key: str, deps: list[str], io: Callable[[], Awaitable[R]],
                       apply: Callable[[R], Effects]) -> Effects:
    async with s.lock:                                   # ① 짧은 구간: 검사·예약
        if s.closed: return Effects.rejected("CALL_ENDING")
        if (op := s.ops.get(key)) and op.status in ("running", "done"):
            return Effects.duplicate(op)                 # 같은 작업 중복 방지
        s.ops[key] = OpRecord(key, ..., deps={f: s.state.field_version(f) for f in deps})
    try:
        result = await io()                              # ② 잠금 없이 외부 I/O (타임아웃 포함)
    except Exception as e:
        result = failure(e)
    async with s.lock:                                   # ③ 짧은 구간: 신선도 검증 후 반영
        op = s.ops[key]
        if s.closed or any(s.state.field_version(f) != v for f, v in op.deps.items()):
            op.status = "stale"; return Effects.stale()  # 늦은 결과는 최신 상태를 덮지 않음
        effects = apply(result); op.status = "done"; s.state_version += 1
        return effects                                   # 송신 명령은 잠금 밖에서 보낸다
```

규칙:
1. Lock 안에서는 `await` 하지 않는다(외부 호출·Decision·RAG·주소·sideband 송신 모두 밖에서). 결과적으로 임계 구역은 동기 코드이며 asyncio에서 원자적이다. Lock은 ②를 사이에 둔 ①·③의 일관성과, 장래에 임계 구역에 `await`가 들어가는 실수를 막는 안전장치다.
2. 서로 다른 통화는 서로 다른 Lock을 쓴다(공유 Lock 없음).
3. 외부 부작용(취소, 결과 전송)은 Lock으로 보호하지 않는다 → `ops` 상태 + BE 멱등성으로 보호(§5).

### 3.2 필드별 버전

- `FieldState.version`: 그 필드가 마지막으로 바뀐 시점의 `state_version`.
- 작업은 자신이 읽은 필드만 `deps`로 기록한다. 예: 받는 곳 주소 보정 `deps={"receiver_address"}` → 그사이 받는 분 성함이 바뀌어도 결과를 반영한다.
- 확인 스냅샷(`pending_confirmation`)은 확인 대상 필드 전체의 버전을 기록한다(§5).
- 전체 `state_version`은 관측·로그·Backend에 주는 상태 요약용이며, 반영 여부 판단에는 필드 버전을 쓴다.

### 3.3 Decision 결과의 신선도

| 검사 | 방법 |
|---|---|
| 낡은 발화 | 서버가 발화 끝마다 호출하므로 결과는 그 `utterance_id`에 묶인다. 더 최신 발화 결과를 이미 적용했으면 폐기(트리거 시절의 세트 ID·순서 역전 검사는 불필요, `delegation.md` §3.3) |
| 확인 대상 변경 | 호출 시점의 `pending_confirmation.id`를 결과에 묶는다. 정정으로 pending이 바뀌면 이전 결과는 자동 폐기 |
| 결과 도착 시 이미 처리 | 같은 행동 키(`confirm:{pc_id}`)가 `done`이면 무시 |

## 4. 수신 태스크와 이벤트 분기

```python
async def read_loop(s: CallSession):
    while not s.closed:
        raw = await s.sideband.recv_bytes()           # [SDK] AsyncSidebandConnection.recv_bytes
        t = sniff_type(raw)                           # 앞부분에서 "type"만 추출(전체 파싱 전)
        if t in ("session.input_audio.append", "output_audio.delta"):
            continue                                  # 오디오 반사는 파싱하지 않음(D12)
        ev = s.sideband.parse_event(raw)              # SDK 타입으로 파싱
        handler = HANDLERS.get(t)
        if handler: handler(s, ev)                    # 동기 핸들러: 상태 갱신 + 태스크 생성만
```
- `sniff_type`은 바이트 앞부분 정규식 검사로 구현 가능(SDK 메시지 형식이 바뀌면 전체 파싱으로 폴백). 효과는 부하 테스트로 확인.
- 순서가 중요한 것(전사 delta → decision.event, function_call 도착 순서)은 이 루프의 읽기 순서로 보장된다.

## 5. 외부 부작용의 안전한 실행

| 작업 | 보호 장치 | BE 멱등성 |
|---|---|---|
| 택배 담기·수정(ParcelStore) | 내부 상태 변경뿐 — 확인 관문 + 확정 지연, 접수 전까지 수정 가능(P5) | 해당 없음 |
| 신규 고객 등록 | 성함·전화번호·주소 모두 VALID일 때 `ops["register"]` 1회(P7), PIN은 geo 있을 때만 | 409 DUPLICATE_RESOURCE |
| 택배 취소 | `ops["cancel:{o}:{p}"]` 1개만 running. 재시도 전 상세 재조회(기존 `cancel_order`). 확정 지연 후 실행, 실행 시작 후 고객 정정은 결과 안내로만 처리 | 같은 상세 재취소 204(`order-cancel.md`) |
| 통화 결과 전송(주문 생성) | 아웃박스: 키·본문을 전송 전에 영속, 상태 `PENDING→SENT_UNCERTAIN→DONE/FAILED`. 통화당 1행(PK=call_id). 본문은 **ParcelStore 스냅샷 해시와 함께 저장**(본문 생성 후에는 택배 수정을 받지 않음), 전송 직전 보관소 해시와 다르면 전송하지 않고 경보 | `Idempotency-Key` 같은 키 재요청은 기존 결과 반환, 같은 통화 다른 키는 409 |
| PIN 저장 | `ops` 키로 1회, 실패해도 통화 진행 | 409 DUPLICATE_RESOURCE |
| 상담원 전환(refer) | `ops["refer"]` 1회, 확인 관문 후 | OpenAI `refer` 재호출 동작 [미확인] → 1회만 |

## 6. 다중 통화 자원 관리

### 6.1 공유 클라이언트

| 대상 | 클라이언트 | 비고 |
|---|---|---|
| BE | `BackendAPI.http`(httpx2.AsyncClient) 프로세스 1개 | 연결 풀 상한 설정(`limits`) |
| 카카오 | 공유 httpx2.AsyncClient 1개(현재는 호출마다 생성 → 변경) | keep-alive |
| OpenAI | `AsyncOpenAI` 1개(웹훅 검증·sessions·sideband) | sideband는 통화당 WS 1개(불가피) |
| RAG | 기존 `RagService`(동기 클라이언트, 스레드 실행) 1개 | 전용 스레드풀 |

### 6.2 동시성 제한

| 제한 | 기본값(측정 후 조정) | 이유 |
|---|---|---|
| 활성 통화 상한 | 설정값(부하 테스트로 결정) | 초과 시 `reject(486)` |
| BE 동시 요청(전역) | 세마포어 | BE 보호, 연결 풀과 일치 |
| 카카오 동시 요청(전역) | 세마포어 | 호출 한도 [미확인] |
| 리랭커·임베딩(전역) | 세마포어 = GPU 서버 동시 처리 수 | 단일 GPU 자원 |
| 주소 보정 실행기 | 작업자 수 = CPU 코어 일부 | CPU |
| 통화당 진행 외부 작업 | 최대 3, 같은 종류 1 | 한 통화가 자원을 독점하지 않게 |
| 조회 상세 N+1 | 통화당 5 | 기존 `find_parcels` 무제한 gather 보완 |

모든 외부 호출은 타임아웃(`error-recovery.md` §3 예산)을 갖는다. 세마포어 대기 시간도 예산에 포함하고, 대기만으로 예산을 넘으면 `unavailable`을 즉시 반환한다(큐 적체 방지).

### 6.3 CPU 작업 분석

| 작업 | 성격 | 현재 | 방안 |
|---|---|---|---|
| 주소 보정(`app/address/matcher.py`) | 순수 Python CPU(자모·편집거리, 후보 최대 30개 × 건물번호) + SQLite | 전용 스레드풀 2개, 전역 락 제거·스레드별 읽기 전용 연결(2026-11-05). GIL로 실제 병렬화는 안 됨(측정: 105건 동시 2.13s ≈ 순차 2.12s) | ① 전역 락 제거(스레드별 읽기 전용 연결) ② GIL로 병렬화가 안 되면 `ProcessPoolExecutor`(작은 풀, 프로세스별 DB 연결). `AddressService` 인터페이스는 같게 두고 실행기만 교체. **측정 후 선택** |
| Kiwi 토큰화·BM25 | C++ 확장 + Python | `RagService` 스레드 | GIL 해제 여부 [미확인] → 측정. 삭제 차단 시 질의마다 BM25 재생성(`faq_search.py:54`) 비용 측정 |
| sideband JSON 파싱 | 루프 CPU | — | §4 경량 분기 |
| pydantic 검증 | 작음 | — | 없음 |

CPython 3.14 표준 빌드(`.python-version`) 기준. free-threaded 빌드는 의존성 호환이 확인되지 않아 고려하지 않는다.

### 6.4 종료 시 정리 (통화 단위)

1. `closed=True`(임계 구역) → 이후 모든 반영·부작용 거부(결과 전송·인사이트 제외)
2. 타이머 취소, 확정 대기 취소
3. `tasks` 취소 후 `gather(return_exceptions=True)`를 상한 시간만큼 대기. 스레드·프로세스 작업은 취소되지 않으므로 결과를 버린다.
4. 진행 중 외부 부작용(`external_side_effect` running)은 `unknown`으로 기록하고 FINALIZING에서 재조회 1회
5. 결과 아웃박스 기록·전송, sideband 닫기, registry 제거, 상태 객체 참조 해제

## 7. 다중 워커·다중 인스턴스

**프로세스 내부 Lock과 상태로는 여러 Uvicorn 워커·인스턴스 사이의 일관성을 보장할 수 없다.** 문제가 되는 경로:
- OpenAI 수신 웹훅: 어느 워커든 받아 accept·sideband 연결을 한다 → 그 워커가 통화를 소유.
- PBX 종료 웹훅·페르소나 알림: 다른 워커로 갈 수 있다 → 통화를 찾지 못함.
- 웹훅 중복 제거·통화 상한·FAQ 큐 소비자(SQLite 단일 소비자)가 프로세스별로 갈라짐.

| 전략 | 내용 | 비용 |
|---|---|---|
| **S-1 (기본)** 단일 인스턴스·단일 워커 | 모든 통화가 한 이벤트 루프. 용량은 S7 부하 테스트로 결정 | 없음. 가용성은 아웃박스로 결과 유실만 방지 |
| S-2 소유권 라우팅 + 공유 저장소 | 공유 저장소(예: Redis)에 `call:{session_id}→instance`(TTL 임대), `caller:{번호}→[{session_id, incoming_at, instance}]`, 웹훅 중복 제거 키. PBX 종료 웹훅을 받은 인스턴스가 소유자에게 내부 전달(`POST /internal/calls/{id}/pbx-ended`). FAQ 소비자는 리더 1개 | 신규 의존성(승인 필요), 내부 인증 |
| S-3 무상태 + 공유 상태 | 상태를 공유 저장소에 두고 어느 워커든 처리 | sideband가 프로세스에 묶여 있어 부적합 |

**결정(P3): 단일 워커(S-1).** S-2는 단일 루프 한계가 부하 테스트로 확인되고 별도 승인이 있을 때만.
