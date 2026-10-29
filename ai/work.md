# AI 팀 공유 현황 — 2026-10-28

현재 작업: `feat/S15P31D109-132-ai-be-integration` → 병합 대상 `develop-ai`.

## 백엔드 연동(2026-10-28, S15P31D109-132)

백엔드 계약(`spec/orders.md`, `spec/ai-pbx-recordings.md`, develop-backend `3b76406`·Swagger로 확인)에 맞췄다. 백엔드에 변경 요청은 하지 않았다.

| 항목 | 상태 |
|---|---|
| 고객 확인 `POST /api/customers/context` | 등록(주소록을 출발지·도착지 후보로)·미등록·탈퇴(바로 상담원) |
| 통화 결과 `POST /api/orders` | 통화당 한 번, 택배 여러 건은 `parcels`. 통화별 UUID 키, 처리 중이면 같은 키·본문으로 재확인 |
| 결과 종류 | "더 없어요"·끊김 → 확인한 택배 COMPLETE / 상담원 연결 → INCOMPLETE / 접수 그만둠 → CANCELLED |
| 새로 받는 항목 | 규격별 수량(서류·소·중·대)·물품 가액·수거 희망 시각·결제 방식·미등록 고객 성함 |
| 지번·동명·우편번호·좌표 | 카카오 주소 검색(`KAKAO_REST_API_KEY`). 못 찾으면 COMPLETE 대신 INCOMPLETE |
| 조회·수정·취소 도구 | 사용 보류(통화 중 쓸 API 없음). 코드는 유지, 상담원 연결 제안 |
| 배송지 저장 단계 | 삭제(백엔드에 저장 API 없음) |
| 실제 백엔드·카카오·전화 | 미확인. 가짜 테스트 287개 통과 |

실연동 전: `.env`에 `KAKAO_REST_API_KEY`, `BACKEND_MOCK` 비움(또는 false). 결제 방식 선택지 규칙(정산 공통·그룹카드 기업·개인카드 개인)은 백엔드 문서로 추정한 것이라 확인 필요. 인증은 백엔드 S15P31D109-135 이후 추가. 관제 화면 주문 목록은 실제 백엔드에서 비어 보인다.

## RAG 통합(2026-10-27, S15P31D109-122)

추가 통합(2026-10-27): 최신 origin/develop-ai `a056a36`의 가짜 백엔드·PoC 대사·저장된 배송지 가림·상담원 연결/무응답 종료를 합쳤다. GCP 서울 L4 HTTPS REST 리랭커와 로컬 실제 RAG 연결은 확인했으며 운영 서버에는 아직 배포하지 않았다. 전체 가짜 테스트 203개 통과. GPU VM은 중지 상태, 시작마다 900초 후 자동 중지다. 설정·비용·측정은 `deploy/gcp/README.md`와 최신 `docs/rag-handoff.md`를 따른다. 아래 이전 통합 기록의 GPU 미연결 상태는 이번 추가 확인으로 갱신한다.

최신 develop-ai(`2b111f6`)를 기준으로 통합했다. 팀원 작업인 LangGraph/Studio, API별 services/webhooks 분리, PBX 종료 Bearer 처리, 고객 답 판별 지연, develop-ai 자동 배포를 확인하고 유지했다. 기존 feature 브랜치·stash·private 실험 데이터는 보존했다.

| 항목 | 상태 |
|---|---|
| MD 로드·제목/재귀 청킹·large 색인 | 통합, 신규 컬렉션만 등록 |
| BM25+벡터 RRF(0.4/0.6) → Top5 → Qwen → Top3 | 운영 서비스로 분리 |
| backend 도구 선택 → RAG 원문 → Live 직접 전달 | client 위임 경로 구현, 가짜 통합 테스트 |
| 외부 GPU | GCP HTTPS 구축 및 로컬 실제 RAG REST 연결 확인. 운영 서버 연결·실제 전화 미확인 |
| 실제 요금 | 3,500원 고정 제거. 백엔드가 유인 정책표로 계산하도록 계약 협의 필요 |
| 과거95문항 평가 | 데이터/집계/분석 공유. 새 통합/실제 전화 점수로 간주하지 않음 |
| develop-ai 병합·푸시·운영 배포 | 미실행 |

검증: 전체 가짜 테스트191개 통과, Python 구문 검사, FAQ32개 색인 dry-run, 평가95문항/근거/해시 검증, Linux Docker 이미지 빌드 성공. 외부 네트워크를 끈 이미지에서 세션 구성·Kiwi·토크나이저 캐시·FAQ 분할과 torch/scripts/data 제외를 확인했다. 실제 OpenAI/PBX/GPU 호출로 검증한 결과는 아니다.

검색은 읽기 전용이며 주문 상태를 바꾸지 않는다. 기존 고객 확인·발신번호 소유권·접수 중복 방지는 유지한다. Live가 검색 결과를 보되 정책이나 작업 성공을 지어내지 않도록 한다. 장애 시 검색 실패를 짧게 안내하고 접수를 이어간다.

요금 결정: 백엔드에서 유인 기준 서류(극소형)3,850원 / 소박스(소형)4,950원 / 중박스(중형)6,050원 / 대박스(대형)7,150원 계산. 규격별 수량 전달은 2026-10-28 연동으로 해결(안내 요금은 백엔드가 정함). 미확정 접수 금액은 요청에서 생략하고 고객에게 숫자를 확정해 말하지 않는다. 백엔드의 fare 생략 수용·규격 입력·확정 금액 응답은 실연동 전 합의한다.

이전 Live 실험: RRF Recall@5=95/95, Qwen Recall@3=95/95, Hit@1=92/95. Faithfulness0.8579, ContextPrecision0.9895, ContextRecall0.9895, FactualCorrectness F1=0.7214. Relevancy0.4825는 보조 지표이며 정답률이 아니다. 검색 성공과 최종 정책 안내 정확성은 별개다.

자료 위치:

- 운영 연결/실행/미확인 사항: [RAG 인계](docs/rag-handoff.md), [계약](spec/rag.md).
- 평가 정의: [지표 설명](docs/rag-evaluation-metrics.md).
- 검토된 질문·답·근거: `evaluation/datasets/faq_v1/`.
- 실제 기존 집계와 이유: [결과 분석](evaluation/results/analysis.md), `baseline_summary.json`.
- 변경 기록: `docs/WORKLOG.md`, 개인 로그는 별도 자율 폴더.

병합 전에 외부 GPU 연결, 배포 서버 Qdrant 색인, 요금 계약, 실제 전화(FAQ 중간 질문/취소 조건/상담원 동의/실패/끼어들기) 확인이 필요하다. develop-ai 병합 시 자동 배포가 실행될 수 있으므로 준비 상태를 함께 확인한다.
