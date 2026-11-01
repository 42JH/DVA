# CLAUDE.md

디바콜(AI 택배 서비스) 전화 접수 서버. 고객이 PBX로 전화를 걸면 AI가 받아 기사님 방문수거 택배를 접수한다.

## 설계 문서 (`spec/`) — 작업 전에 해당 문서를 먼저 읽는다

| 이 작업을 할 때 | 먼저 읽을 문서 |
|---|---|
| `config/live.toml`, GPT-Live 세션 파라미터 | `spec/gpt-live-session.md` |
| `config/server.toml`에 항목 추가, 코드의 숫자·문구 | `spec/server-config.md` |
| 웹훅, accept·reject·hangup·refer, 발신번호 | `spec/pbx-sip.md` |
| sideband 이벤트 처리, 함수 호출 결과 반환, `thinking.append`, 받아쓰기, 종료 타이밍 | `spec/sideband.md` |
| 통화 레지스트리, async 처리, 동시 통화 상한 | `spec/concurrency.md` |
| 도구 추가, 디스패처 | `spec/tools.md` |
| 통화 흐름 구조(서버는 가드레일: 업무·확정 관문), 상태 엔진(LangGraph), 진행 상태 문구, Studio로 흐름 보기(`studio/`, `langgraph.json`) | `spec/flow.md` |
| 단계·분기·시나리오(고객 응대 흐름) | `spec/flow.md`(구조), `spec/scenario.md`(구현 결정), `spec/LANGGRAPH_REVIEW.md`(보완사항·결정), `spec/LANGGRAPH_REBUILD.md`(다이어그램 문구·조회·QnA 노드의 원래 정의) |
| 관제 화면(임시), SSE | `spec/monitor.md` |
| 고객 확인·통화 결과 접수(백엔드 서버 API) | `spec/backend-api.md` |
| 통화 기록(받아쓰기·도구 실행·처리 결과)·분석 전송 | `spec/insights.md` |
| 주소 보정(행안부 주소DB), 지번·우편번호·좌표(카카오), `app/address/` | `spec/address.md` |
| 페르소나(관리자가 고치는 음성 지시문 전체·음성), `/internal/persona` | `spec/persona.md`, 백엔드 계약 `spec/ai-persona-next-call.md` |
| 매뉴얼 RAG(Qdrant) | `docs/rag-handoff.md`(RAG 담당자 인계) |
| FAQ 변경 알림·영속 큐·추가/수정/삭제 동기화 | `spec/faq-sync.md`, `docs/faq-management-plan.md` |

설계가 바뀌면 해당 `spec/` 문서를 같이 고친다. 같은 내용을 두 곳에 쓰지 않는다.

## 작업 규칙

- 사용자와는 한국어로. 코드 주석·문서·커밋 메시지도 한국어(식별자는 영어).
- `.env`는 읽지도, grep하지도, 고치지도 않는다. 값 확인이 필요하면 사용자에게 물어본다.
- 테스트는 실제 OpenAI API·PBX를 부르지 않는다(가짜 클라이언트, 서명한 가짜 웹훅, 가짜 백엔드 API). 실제 통화 확인은 사용자가 한다.
- GPT-Live API는 새 기능이다. 이벤트·파라미터·엔드포인트 이름은 기억에 의존하지 말고 공식 문서와 설치된 SDK 타입으로 확인한다. `spec/`에 "미확인"으로 표시한 것은 구현 전에 반드시 확인한다.
- 작업이 끝나면 `docs/WORKLOG.md`에 날짜별로 바꾼 것·확인한 것·남은 것을 적는다.
- 커밋·푸시는 사용자가 요청할 때만.

## 스택과 실행 환경

- Python(버전은 자유, 최신 안정판 권장). `.python-version`과 Docker 베이스 이미지의 버전을 맞춘다.
- 패키지 관리: **uv**. `pyproject.toml` + `uv.lock`을 커밋하고, 의존성은 최소로 둔다: `fastapi`, `uvicorn`, `pydantic`, `openai[realtime]`(`client.live`, `client.webhooks` 사용), `langgraph`, dev `pytest`·`langgraph-cli[inmem]`(LangGraph Studio, 개발용). HTTP 호출(백엔드 API)은 `openai`에 딸린 `httpx2`를 쓴다.
- LLM 호출은 전부 **openai SDK**(gpt-live-1 세션, 백엔드 도구 선택, 고객 답 판별). 사용자 요청에 따라 **RAG 임베딩·검색·분할만 LangChain**을 쓴다. RAG는 `docs/rag-handoff.md`, 평가 정의는 `docs/rag-evaluation-metrics.md`를 먼저 읽는다. Qwen은 외부 `/rerank` 서비스이며 전화 서버에 torch를 설치하지 않는다.
- 시나리오 분기(상태 엔진): **LangGraph** `StateGraph`. 단계 = 노드, 사건 하나 = 그래프 실행 한 번(`spec/flow.md`). 에이전트·도구 루프로는 쓰지 않는다.
- 웹 서버: **FastAPI** 하나(PBX 웹훅, 관제 API·SSE, 관제 화면).
- 배포: **Linux에서 Docker로 띄운다.** 개발 PC는 Windows이므로 경로는 `pathlib`, 인코딩은 UTF-8로 OS에 의존하지 않게 쓴다.
  - 이미지: uv로 `uv sync --frozen --no-dev` 설치, 컨테이너 안에서는 `uvicorn ... --host 0.0.0.0`.
  - 비밀값은 이미지·설정 파일에 넣지 않고 실행 시 환경변수로: `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `BACKEND_API_URL`, `KAKAO_REST_API_KEY`, `AI_PERSONA_TOKEN`, `AI_INSIGHTS_TOKEN`, `QDRANT_API_KEY`, 관제 화면 인증값.
  - 설정 파일 두 개(`config/live.toml`: GPT-Live 세션, `config/server.toml`: 서버 변수)와 프롬프트는 볼륨으로 마운트한다(이미지 재빌드 없이 조정).
  - docker compose로 서버와 매뉴얼 RAG용 `qdrant`를 함께 띄운다(`ai/compose.yaml`, 루트 compose와 별개). Qdrant 데이터는 볼륨에, 포트는 밖으로 열지 않는다(내부 네트워크).
  - 통화별 상태가 프로세스 메모리에 있으므로 **워커는 1개**로 띄운다. 동시 통화는 워커를 늘리지 않고 asyncio로 처리한다(`spec/concurrency.md`).
  - OpenAI 웹훅을 받아야 하므로 서버는 **공인 HTTPS 주소**로 열려 있어야 한다(TLS는 앞단 리버스 프록시).
- 개인정보(이름·전화번호·주소·받아쓰기)를 다룬다. 관제 화면·API는 인증 뒤에만 열고, `.env`는 커밋하지 않는다.
- 테스트: `uv run pytest -q`. 백엔드 API는 가짜 백엔드(`tests/conftest.py`의 `FakeBackend`)로, API 클라이언트는 가짜 HTTP 전송으로 시험한다.

## 구조

```text
고객 ─ 전화망 ─ PBX ──SIP(TLS 5061, SRTP)──▶ OpenAI GPT-Live (gpt-live-1)
                                               │ ① 웹훅 live.transport.incoming
                                               ▼
서버(FastAPI) ── ② POST /v1/live/sessions/{session_id}/accept {session: config/live.toml}
             ── ③ sideband wss://api.openai.com/v1/live/sessions/{session_id}/attach
                    · 백엔드 function_call → 도구 실행 → 결과 반환
                    · 사건(백엔드 보고·확인 단계 판별) → 상태 그래프(LangGraph) → thinking.append
                    · 받아쓰기·상태 → 관제 화면(SSE)
             ── ④ refer(상담원 전환) / hangup(종료)
             ── 백엔드 서버 API(고객 확인·통화 결과)   ── 카카오(주소 좌표)   ── Qdrant(매뉴얼 RAG)
```

- 음성은 PBX와 OpenAI가 직접 주고받는다. 서버는 오디오를 다루지 않는다.
- 생각·도구: 지금 `delegation.type = "responses"`. Live 쪽 백엔드 모델이 도구를 고르고 서버가 실행해 `function_call_output`으로 돌려준다(`[backend]` 설정을 `delegation.responses`로 넣어 보냄). `client`(서버가 SDK로 도구를 고르고 원문 결과를 Live에 직접 전달)는 코드는 있으나 2026-10-28 실제 통화에서 client 위임이 한 번도 생기지 않아 보류 중이다(`docs/WORKLOG.md`).
- 저장: **AI 서버는 고객·주문·배송지를 저장하지 않는다.** 이 정보를 관리하는 별개의 백엔드 서버 API로 읽고 쓴다(`spec/backend-api.md`). 통화 시작에 고객 확인(통화 번호 `callSessionSeq`·결제 자격·이전 접수 주소), 통화 중 조회·취소(`call_session_seq` 헤더), 통화 끝에 결과(`POST /api/orders`, 택배들은 `parcels`) 한 번. 백엔드 호출은 모듈 하나(`app/backend_api.py`)에 모은다. 받는 중인 택배(임시 주문)와 확인한 택배 목록만 통화별 메모리.
  - 매뉴얼 RAG는 **Qdrant**(벡터 DB)에 둔다. 개인정보와 섞지 않는다. 구현은 RAG 담당자 몫(`docs/rag-handoff.md`).
- 프롬프트는 파일 두 개: 음성 모델용(말투·맞장구·끼어들기·위임 정책)과 백엔드용(도구 규칙·결과 돌려주기).

## 안전장치 (코드에서 강제, 프롬프트에만 맡기지 않는다)

- 웹훅은 서명 검증을 통과한 것만 처리한다. SIP 헤더(발신번호 포함)는 미신뢰 입력이다.
- 모델이 만든 도구 인수는 미신뢰 입력: pydantic(strict 스키마)으로 검증한 뒤에만 실행. 도구 예외는 통화를 끊지 않고 오류 결과로 돌려준다.
- 택배 담기·접수·상담원 전환은 그 단계의 확인 질문에 대한 고객 답을 서버가 판별했을 때만 실행(선택지 밖 판별·다른 단계의 판별은 버림). 택배 담기는 접수 내용 되읽기(`A_CONFIRM`)의 "예"를 판별하고 확정 지연 뒤에 한다(`spec/LANGGRAPH_REVIEW.md` 1번). 취소는 고객의 "예"를 판별하고 확정 지연(`commit_delay_ms`) 뒤에 서버만 실행한다(`customer_confirmed=true` 없으면 거절). 수정 도구는 사용 보류.
- 주소록은 **발신번호 주인 것만** 쓴다(모델이 넘긴 번호가 아니라 서버가 아는 발신번호로 고객 확인).
- 전화번호: 한글 숫자("공일공 일이삼사")를 숫자로 바꾸고, 자릿수가 틀리면 저장하지 않고 다시 확인시킨다(010은 11자리, 0으로 시작 9~11자리, 15xx·16xx·18xx 8자리). 저장은 숫자만.
- 택배는 모델이 다시 말한 값이 아니라 **임시 주문 그대로** 담고, 담은 뒤 임시 주문을 비운다. 접수는 담은 택배 그대로, 통화당 한 번.
- 백엔드 API: 전화번호·이름 같은 개인정보는 URL에 넣지 않는다(전화번호는 본문으로, 받는 분 성함 거르기는 AI 서버가). 경로에 넣는 값(접수번호 등)은 경로 조각으로 인코딩. 주문 항목은 정해진 이름 목록으로만 보내고, 모르는 값은 기본값을 지어 넣지 않고 뺀다.
- 접수번호는 백엔드가 발급한다. 통화 결과에 통화마다 UUID 하나인 `Idempotency-Key`를 붙이고, 재요청은 같은 키·같은 본문으로만 한다. 응답 `data.status`가 `ACCEPTED`일 때만 접수됐다고 안내한다.
- 관제 화면·API는 인증 필수. 도구 인수·결과와 받아쓰기는 개인정보다.
- LangSmith 추적(`LANGSMITH_TRACING`)은 켜지 않는다(langgraph와 함께 설치되지만 기본은 꺼져 있음, Studio용 `langgraph.json`에서도 `false`로 고정). 켜면 실행 기록이 외부로 나간다. 그래프 상태에는 개인정보를 넣지 않는다(통화 객체는 `context`로).

## 설계 원칙

- **대화는 Live-1, 서버는 가드레일**(2026-11-01·11-02 결정, `spec/flow.md`): 고객이 무슨 말을 하든 음성 모델이 응대하고(정정·되물음·다른 용건), 알아들은 것을 백엔드가 도구로 보고한다. 서버는 기록된 값·빠진 항목·권장 다음 질문·제안을 `thinking.append`로 알려 줄 뿐 대본으로 강제하지 않는다. 서버가 코드로 강제하는 것은 값 검증과 되돌릴 수 없는 동작(택배 담기·접수·취소·상담원 전환)의 확인 단계다. 상태 그래프의 노드는 업무와 관문만(정보 받기는 `ORDER` 하나).
- **주문 값은 언제든 기록한다.** 고객이 순서 밖에서 말하거나 정정해도 단계가 기록을 막지 않는다(버리지 않는다).
- **고객 말의 뜻은 서버 판별기가 아니라 Live-1이 정한다.** 지금 질문의 답은 백엔드 `answer`(선택지 중 하나), 다른 일은 `switch_task`로 보고하고, 답이 아니면 흐름이 움직이지 않는다. 서버가 고객 받아쓰기를 직접 판별해 옮기는 것은 확인 단계(`Stage.confirm`)의 답뿐이다(작은 판별기가 선택지 밖의 말을 가장 가까운 선택지로 읽어 흐름이 엉뚱하게 넘어가던 것, 2026-11-01 23:14 통화). 확인 단계 밖의 판별은 위임 안전망(맡기지 않은 말을 백엔드에 넘김)으로만 쓴다.
- **임시 주문이 유일한 근거.** 요약·되읽기·접수는 모델 기억이 아니라 기록된 값으로 한다.
- 진행 상태는 백엔드가 기록한 *뒤에야* 바뀌어 한 박자 늦을 수 있고, 그사이 같은 질문을 되풀이하기 쉽다. 설계 단계에서 이 지연을 고려한다.
- `thinking.append` 문구는 짧게 유지한다(항목이 다 차고 주소가 길어도 500토큰 이하).
- 통화 처리(웹훅·sideband)는 관제 화면과 독립이다. 관제 화면을 아무도 안 보고 있어도 통화는 끝까지 처리된다.

## 아직 없는 것

- 통화 중 주문 수정은 보류(`spec/backend-api.md`). 조회는 최근 `lookup_limit`건 안에서만 받는 분 성함으로 찾는다.
- 요금 계산 API: 백엔드는 배송비를 계산하지 않고 AI가 보낸 값을 검사한다. AI가 서버 요금표(`config/server.toml` `[fare]`, 유인 지점 요금)로 계산한다(거리·무게 할증 없음). 결제 요청 메시지(알림톡)·결제사 연동, 발신(outbound) 전화도 없다. AI는 결제 완료·메시지 발송을 안내하지 않는다. RAG 코드는 통합됐지만 외부 GPU 연결과 실제 전화 통합 확인은 별도다.

## 브랜치와 기록

- 사용자 제공 팀 규칙은 `docs/BRANCH_STRATEGY.md`를 따른다. `develop-ai`에서 작업 브랜치를 만들고 그 브랜치에서 병합을 준비한다.
- 커밋은 `feat: 한국어 설명` 형식이며 Jira 번호(`S15P31D109-122` 등)는 본문 마지막 독립 줄에 둔다. 사용자 요청 없이 develop-ai 병합·푸시·배포하지 않는다.
- 팀 공유 현황은 `work.md`, 날짜별 변경은 `docs/WORKLOG.md`에 쓴다. 개인 개발로그는 사용자가 지정한 `C:/Users/SSAFY/Desktop/자율/개발로그.md`에 중복 번호 없이 이어 적는다.
- 평가 질문/기준 답변은 `evaluation/datasets/`, 집계 결과는 `evaluation/results/`. 실제 통화 개인정보·모델 가중치·대용량 실행 기록은 커밋하지 않는다. 과거 실제 실험은 `data/private/evaluation/runs/`에 보존한다.
- 백엔드 API 인증(백엔드 담당자가 정함).
