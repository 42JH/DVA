# 설계 결정 기록

결정일: 2026-11-03 · 결정자: 사용자 · 이 문서가 다른 설계 문서와 다르면 이 문서가 우선한다.

| # | 항목 | 결정 | 설계 반영 | 남은 위험·후속 |
|---|---|---|---|---|
| P1 | 수거 시각 | **(2026-11-03 변경) 묻지 않는다.** 실제 수거는 BE가 결제 완료 + 1시간으로 정하고 `pickupRequestedAt`은 호환 선택값(BE 최신 규약 `spec/ai-integration-current.md` §3, 사용자 결정 1-b). "기사님이 결제 완료 후 1시간 안에 방문"으로만 안내 | 정책에서 수거 단계·필드 제거, `record_fields` 인수 제거, 결과에 `pickupRequestedAt` 없음, COMPLETE 조건에서 제외. `parse_pickup`(P1 규칙)은 남겨 둠 | 이전 결정(고객 희망 시각, 현재 + 1시간 이후)은 폐기 |
| P2 | 운영 지시문 원천 | **BE 페르소나 `promptText` 우선. 불러오지 못하면 서버에 있는 프롬프트 사용** | Live `instructions` = `promptText`(우선) + 정책 렌더링(절차·필수 항목·금지 행동). `promptText` 확보 실패(조회 오류·타임아웃·404·빈 값) 시 서버 기본 프롬프트(`policy/default_prompt` — 기존 `docs/call-flow/voice.md` 기반)로 대체. 통화 시작 시 1회 결정, 통화 중 바꾸지 않음(F1). 대체한 통화는 분석의 `aiPersonaVersionSeq`=null, 지표 `persona_fallback_total` | 페르소나가 절차를 빠뜨려도 업무 결과는 하드 gate로 보호(`workflow-policy.md` §5) |
| P3 | 배포 | **단일 워커** | `uvicorn --workers 1`. 다중 워커·인스턴스는 범위 밖(`concurrency.md` §7 S-1) | 단일 프로세스 장애 시 진행 통화 영향. 결과는 아웃박스로 보존 |
| P4 | 긴급 정정 상한 | **3회 이후 상담원 이관 제안** | N3 통화당 3회. 4번째 정정이 필요한 상황이면 정정 대신 상담원 이관 제안 사실을 전달(P11 설정이 없으면 대체 안내) | — |
| P5 | 담은 택배 수정 | **접수(통화 결과 전송) 전까지 통화 안에서 수정 가능.** 별도 메모리에 임시 보관, 고객 요청 시 수정 | `ParcelStore`(통화별, 현재 택배와 분리) — 담은 택배는 불변 스냅샷이 아니라 수정 가능한 항목. 수정 시 해당 택배는 미확인으로 돌아가 다시 되읽기·확인(`conversation-state.md` §2·§4·§7) | 수정 후 재확인 전에 통화가 끝나면 그 택배는 미확인 → 결과 규칙(아래 후속 질문) |
| P6 | 애매한 주소 | **1순위 자동 확정, 이후 변경 가능** | ambiguous → 1순위를 VALID로 기록(`auto_selected=true`, 나머지 후보 보관). 이후 고객이 정정하면 일반 정정 경로로 변경 | 자동 확정에 대한 추가 보완 장치는 두지 않는다(사용자 결정: 고려하지 않음) |
| P7 | 신규 고객 자동 등록 | **(2026-11-03 변경) 원본 서버 흐름 + 내 주소**: 미등록 고객이 보내는 분 성함·주소·상세를 다 말하면 통화당 1번 `POST /api/customers {name, phoneNumber, address?}` → 같은 통화로 고객 확인 재호출 → 보내는 곳 PIN. `address`(이름·번호 없는 내 주소)는 지번·동명·우편번호까지 있을 때만(사용자 결정) | `app/calls/results.py register`(백그라운드, 대화 대기 없음). 실패하면 결과는 `customer{보내는 분 성함, 발신번호}` | 결과 본문 `customer`로 BE가 고객을 만드는지는 규약에 없음 — 원본처럼 등록 API를 따로 부른다 |
| P8 | 발화 문구 | 전할 사실·금지 표현만 준수. **추후 정형화된 스크립트로 바뀔 수 있음** | 전달 형식에 선택 필드 `script_id`를 예약(현재 미사용). 정책 파일 `[speech]`에 스크립트 영역 예약 | 스크립트 도입 시 Live instructions 재렌더링만으로 반영되게 유지 |
| P9 | 지연 목표 | 기본안: 기준선 측정 후 목표 설정, P95 10% 이상 악화 시 배포 보류 | `latency-strategy.md` §6 그대로 | — |
| P10 | 조회 범위 | 최근 5건 한계 수용 | `lookup_limit=5` 유지(설정값) | — |
| P11 | 상담원 전환 대상·운영 시간 | **미정, 수정 가능하게** | `AgentTransferConfig{target_uri?, open_hour?, close_hour?}` 설정값(재배포 없이 바꿀 수 있는 설정 파일/환경변수). 미설정이면 상담원 제안 대신 "담당자가 확인 후 연락" 안내 + 결과 INCOMPLETE | 미설정 동안 P4·재질문 한도 초과 시 이관이 불가 |
| RAG | RAG 소유권 | **RAG는 다른 담당자의 구현 — 원본에서 그대로 가져오고 수정하지 않는다**(Qdrant, 리랭커 서버·호출, 색인·FAQ 동기화 등) | 원본 경로·내용 그대로: `app/rag/`, `app/webhooks/faqs.py`, `manuals/`, `config/rag-*.json`, `prompts/rag_context.md`, `config/server.toml` `[rag]`·`[faq_sync]`, `gpu/`, RAG `scripts/`, `evaluation/`, 원본 RAG 테스트(`tests/`). 원본 서버 공용 의존은 우리 쪽 호환판(`app/config.py`, `app/backend_api.py`, `app/webhooks/pbx.py`)으로 맞춘다. 새 서버는 `RagService`를 호출만 한다 | RAG 쪽 변경은 원본에서 다시 복사해 반영(`cmp`로 바이트 동일 확인). 원본 테스트 4개는 원본 서버 앱 의존으로 제외 |
| BE | BE 계약 변동성 | **BE 규약은 언제든 바뀔 수 있다**(BE 설계 미완성, 필드 변경 가능) | 계약을 한 곳(`app/integrations/backend/`)에 격리, 계약 테스트를 문서 버전별 픽스처로, 응답은 쓰는 필드만 검증하고 나머지는 무시(tolerant reader), 요청 본문 생성은 매핑 함수 1개, MockBackend 동기화(`overview.md` §7) | AI가 임의로 계약을 바꾸지는 않는다(AGENTS.md §2). BE 변경을 받아 반영하는 절차를 둔다 |
| S0b | 위임 Backend 처리 등급·재개 방식 | **`service_tier="priority"`(= Fast mode) 고정, 도구 결과 뒤 항상 `response.create`로 재개** (사용자 결정 2026-11-03) | 위임 설정 `responses.service_tier="priority"`. Backend 생성 1회 기본 ~9초(S0 3.4~5.1초) → priority 0.5~0.9초, 고객 말 끝 → 결과 발화 3.1초(`spikes/s0/RESULTS.md` S0b). 최종 문장 생략(서버 commentary)은 Live가 27초간 정지해 폐기 | 단가 Standard의 2배(`gpt-6-luna` 입력 $0.20·캐시 $0.02·출력 $1.00 /1M, 2026-11-03 가격표). 실측 b2 기준 위임 2회 ≈ $0.0005. 트래픽 급증 시 표준으로 강등될 수 있음(응답 `service_tier`로 확인 → 지표 `backend_tier_downgraded_total`). 계정 한도·p95는 S7에서 측정 |
| S0c | Decision 호출 방식 | **Live 트리거를 쓰지 않고, 서버가 고객 발화 끝에 독립 `POST /v1/decisions`를 1번. 출력 전사 감시 제거** (사용자 결정 2026-11-03) | 발화 끝 = 마지막 입력 delta 뒤 800ms 무 delta. 입력 = 직전 AI 발화 + 고객 발화, 질문 세트는 단계별, confirm은 pending이 있을 때만. 예산 1.0초, 서버 시작 시 웜업. 조기 되읽기는 gate로 막고(감지 안 함), 고위험 결과 문구만 서버가 결정적으로 검사 → N3(다음 턴) (`delegation.md` v3.1) | 근거 `spikes/s0c/RESULTS.md`: 토큰 564k → 21k(1/27, 5분 통화 추정 ~$0.08 → ~$0.003), 웜 p50 251·p95 284ms, 확인 질문 아닐 때 yes 오판정 4 → 0. 결과는 트리거보다 ~0.9초 늦지만 Live 응답을 막지 않음. 표본 57발화, 부하 중 delta 간격 [미확인] |
| FARE | 배송비 요금표 | **원본 요금표·규칙 그대로**(사용자 결정 2026-11-03): 서류 3,850·소형 4,950·중형 6,050·대형 7,150원(방문수거 = 유인 지점, VAT 포함, 원본 2026-10-31 결정) | `config/server.toml` `[fare]`, `app/domain/fare.py`(배송비 = 규격별 개수 × 요금 합, 요금 없는 규격·기타 물품·물품 없음 → 모름 → INCOMPLETE), `app.state.svc.fare_of` → `decide_outcome` | 거리·무게 할증 없음. 요금 규칙이 바뀌면 `[fare]`만 수정 |
| PAY | 결제 방식 | **가능한 방식(availablePaymentMethods)이 하나면 자동, 여럿이면 묻고, 없으면 생략**(사용자 결정 3, BE 최신 규약: 기본 billing 금지·COMPLETE는 선택 필요) | `assess.payment_auto`, Decision `pay` 선택지 = 고객의 실제 가능 방식(카드·월결제·부서 그룹결제) | 미등록 고객은 등록(P7) 후 받은 목록으로 정해진다. 등록 실패면 결제 없음 → INCOMPLETE |
| S6 | 통화 결과 전송 시점 | **"더 없음" + 결제 방식이 정해지면(또는 고객이 끝낼 때) 백그라운드로 전송, 대화는 기다리지 않음**(사용자 결정 2-b) | 아웃박스(SQLite `state/outbox.sqlite3`)에 키·본문을 전송 전 영속, 같은 키·본문 재시도·재시작 복구. 마무리 전에 응답이 오면 상태를 N1'로(ACCEPTED만 접수 성공, notPaid는 결제 대기), 늦으면 중립 마무리. 분석·이벤트·미답변은 통화 끝 | SUBMITTING·SUBMITTING_FAILED는 BE 자동 재시도 중 — 새 키 금지. 응답 유실 뒤 디버 외부 중복 가능성은 BE 규약상 미해결(§3) |

## P5 후속 (결정: B안)

수정한 택배를 다시 확인하기 전에 통화가 끝나면 → **수정 전의 마지막 확인 스냅샷으로 전송**한다.

- `StoredParcel`은 해시뿐 아니라 마지막 확인 스냅샷 자체(`confirmed_snapshot`)를 보관한다.
- 결과 본문은 택배마다: 현재 내용이 확인됐으면 현재 내용, 수정 중(미확인)이면 `confirmed_snapshot`. 수정 중 바뀐 값은 전송하지 않는다.
- 이렇게 만든 본문이 COMPLETE 필수값을 충족하면 COMPLETE(`conversation-state.md` §7).
- 고객이 수정 의사를 밝힌 내용이 반영되지 않은 채 접수될 수 있다 → 통화가 정상 마무리되는 경우에는 Live가 정책상 미확인 수정을 먼저 마치도록(`assess().parcels_pending_reconfirm`) 안내한다.
