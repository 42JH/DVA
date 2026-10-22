# 통화 시나리오와 분기

## 시작

| 조건 | 첫 단계 |
|---|---|
| 신규(발신번호 없음, 또는 지난 주문·저장된 배송지가 모두 없음) | `collecting`(신규 순서) |
| 등록, 최근 배송 있음 | `recent_offer` |
| 등록, 최근 배송 없음 | `find_destination`(저장된 받는 곳이 없으면 바로 `collecting`) |

- 등록 고객 = 발신번호로 지난 주문이나 저장된 배송지가 있음. 최근 배송 = 취소되지 않은 마지막 주문. 둘 다 통화 시작 때 백엔드 API로 받는다(`spec/backend-api.md` 1번).
- 저장된 배송지는 종류(출발지 `origin` · 도착지 `destination`)를 나눠 저장한다. 발신번호 주인 것만 찾는다.

## 단계와 분기

각 단계의 질문에 대한 고객 답(예/아니오, 어느 곳, 맞음/정정 등)은 서버가 고객 말을 직접 판별해 분기한다(`spec/flow.md`). 이름·연락처·주소·물품 같은 값과 접수된 주문의 조회·수정·취소만 백엔드 도구로 한다.

### `collecting` — 주문 정보 받기

- 신규 순서: 보내는 분 이름 → 보내는 분 연락처 → 출발지 → 도착지 → 받는 분 이름 → 받는 분 연락처 → 물품
- 등록 순서: 도착지 → 받는 분 이름 → 받는 분 연락처 → 출발지 → 보내는 분 이름 → 보내는 분 연락처 → 물품

| 조건 | 다음 |
|---|---|
| 필수 항목이 다 참 | `confirming` |
| 등록 고객, 다음 항목이 출발지, 저장된 출발지 있음(주문마다 한 번) | `find_origin` |
| 그 밖 | 다음 항목 |

### `recent_offer` — 최근 배송으로 보내는지

| 답 | 다음 |
|---|---|
| 예 → 최근 배송의 출발지·도착지·보내는 분·받는 분 채움 | `collecting`(물품) |
| 아니오 | `find_destination` |

### `find_destination` — 저장된 받는 곳 찾기

| 결과 | 다음 |
|---|---|
| 1곳 → 도착지·받는 분 채움 | `collecting` |
| 이름만 말함 | 지역 묻고 다시 찾기 |
| 여러 곳 | 지역·건물명 묻고 다시 찾기 |
| 0곳(처음) | 주소 더 묻고 다시 찾기 |
| 0곳(다시 찾아도) 또는 새 받는 분 | `collecting`(도착지부터) |

### `find_origin` — 보내는 곳이 지난번과 같은지

| 답 | 다음 |
|---|---|
| 같음, 저장된 출발지 1곳 → 출발지·보내는 분 채움 | `collecting` |
| 같음, 여러 곳 | 어느 곳인지 묻고 다시 찾기 |
| 다름 | `collecting`(출발지부터) |

### `confirming` — 마지막 확인

| 답 | 다음 |
|---|---|
| 맞음 → 접수 | `submitted` |
| 정정, 필수 항목 다 있음 | `confirming` |
| 정정, 빠진 항목 생김(예: 주소만 바꿔 상세 주소를 다시 물어야 함) | `collecting` |

### `submitted` — 접수 안내

머무르지 않고 바로 넘어간다. 접수번호 안내는 다음 단계의 진행 문구에 있다. 접수번호는 백엔드가 발급한다.

| 조건 | 다음 |
|---|---|
| 저장 안 된 배송지 있음 | `save_offer` |
| 없음 | `after_order` |

### `save_offer` — 배송지 저장 여부

| 답 | 다음 |
|---|---|
| 동의 → 저장(신규 고객은 등록 고객이 됨) | `after_order` |
| 거절 | `after_order` |

### `after_order` — 추가 주문·용건

| 답 | 다음 |
|---|---|
| 새 주문 | 통화 시작과 같은 규칙(신규 → `collecting`, 등록 → `recent_offer` / `find_destination`). 이번 통화에서 접수한 주문이 최근 배송 |
| 수정·취소·조회·상담원 연결 | 하위 흐름 |
| 없음 | `ending` |

### `ending` — 마무리 인사 후 종료

## 하위 흐름

어느 단계에서나(`ending` 제외) 들어가고, 끝나면 들어온 단계로 돌아간다. 돌아간 단계는 같은 사건을 다시 본다(예: `after_order`에서 조회 중 "새 주문" → 복귀 후 새 주문 시작). 수정·취소는 주문번호 + 발신번호로 대조한다.

| 흐름 | 분기 |
|---|---|
| `lookup` 조회 | 있음 → 안내 / 없음 → 없다고 안내. 안내 후 복귀 |
| `modify` 수정 | 성공 → 안내(요금 바뀌면 함께. 지금 요금은 고정) / 주문번호·연락처 불일치 → 다시 받기 / 취소된 주문 → 수정 불가 안내 / 고객이 그만둠 → 복귀 |
| `cancel` 취소 | 성공 → 안내 / 불일치 → 다시 받기 / 이미 취소됨 → 안내 / 고객이 그만둠 → 복귀 |
| `handoff` 상담원 연결 | 예 → 전환 후 종료 / 아니오 → 복귀 |
| 종료 요청 | `ending` |

## 시나리오

아래 표는 `tests/test_flow.py`의 `SCENARIOS`에 그대로 있다. 시나리오를 추가하면 둘 다 고친다.

| 시나리오 | 경로 |
|---|---|
| 신규 접수, 저장 동의 | `collecting` → `confirming` → `submitted` → `save_offer`(동의) → `after_order` → `ending` |
| 신규 접수, 저장 거절 | `collecting` → `confirming` → `submitted` → `save_offer`(거절) → `after_order` → `ending` |
| 등록, 최근 배송 그대로 | `recent_offer`(예) → `collecting` → `confirming` → `submitted` → `after_order` → `ending` |
| 등록, 저장된 배송지로 | `find_destination`(1곳) → `collecting` → `find_origin`(같음) → `collecting` → `confirming` → `submitted` → `after_order` → `ending` |
| 등록, 받는 곳 못 찾음 | `find_destination`(0곳) → `find_destination`(0곳) → `collecting` → … → `submitted` → `save_offer` → … |
| 등록, 출발지만 바뀜 | … → `find_origin`(다름) → `collecting` → … → `submitted` → `save_offer` → … |
| 마지막 확인에서 정정 | … → `confirming`(정정) → `confirming`(맞음) → `submitted` → … |
| 추가 주문 | … → `after_order`(새 주문) → `collecting` → … → `after_order`(없음) → `ending` |
| 접수 중 취소 요청 | `collecting` → `cancel` → `collecting` |
| 상담원 연결 | 아무 단계 → `handoff`(예) → 종료 |
