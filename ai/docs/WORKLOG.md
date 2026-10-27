# 작업 기록

## 2026-10-20

### 바꾼 것
- 패키지 관리를 uv로 바꿈: `pyproject.toml` + `uv.lock`, Python 3.14(`.python-version`, Docker `python:3.14-slim`). `requirements.txt` 삭제.
- 설정: `config/server.toml`(서버 변수, `app/config.py`로 검증), `config/live.toml`(GPT-Live 세션, 통화마다 읽음).
- 프롬프트: `prompts/voice.md`(음성 모델), `prompts/backend.md`(백엔드), `prompts/flow.toml`(단계·항목 진행 문구).
- 통화 처리
  - `app/webhook.py`: 서명 검증 → 200 → 백그라운드에서 accept·reject.
    - `webhook-id`·`session_id` 중복 제거, 동시 통화 상한 넘으면 reject.
  - `app/call.py`: 통화 객체·레지스트리. 발신번호 정규화·마스킹, 끝난 통화 정리.
  - `app/sideband.py`: 함수 호출 실행 → `function_call_output` + `response.create` → `thinking.append`.
    - 받아쓰기 말풍선을 처리한다.
    - 종료·전환은 안내 말이 끝난 뒤에 한다.
  - `app/dispatcher.py`: 도구 실행 파이프라인 한 곳. 모든 실패를 오류 결과로 돌려준다.
  - `app/live_session.py`: live.toml → accept 본문.
- 상태 엔진 `app/flow/engine.py`(업무 모름)와 단계 정의 `app/flow/stages/`(자동 등록, 기동 시 검증).
- 도구 13개 `app/tools/`(자동 등록, strict 스키마).
- 주문 항목: 보내는 분·받는 분 각각 이름·전화·기본 주소·상세 주소, 물품 종류(사용자 확정).
- DB: `app/db.py` + `app/schema.sql`.
  - 테이블: `orders`, `saved_places`.
  - 접수번호는 시퀀스로, 접수와 같은 문장에서 발급한다.
- 관제 화면(임시): `/monitor`. HTTP Basic, SSE, 접수 주문 목록.
- `ai/compose.yaml`: `ai` + 전용 `ai-db`(pgvector/pgvector:pg17, 내부 네트워크). 루트 compose는 건드리지 않음.
- spec 반영: pbx-sip, gpt-live-session, sideband, flow, tools, monitor, server-config. AGENTS.md(psycopg pool, compose 위치).

### 확인한 것
- openai SDK 3.35.1
  - `client.live.sessions.accept/reject/hangup/refer`, `client.live.sideband.connect`, `session.thinking.append(delegation_id=None)`가 있다.
  - `response.item.create`·`response.create`, `LiveTransportIncomingWebhookEvent`가 있다.
  - spec의 "미확인" 메서드 이름이 해결됐다.
- SDK 타입과 spec이 다른 점
  - accept 본문에 `type="live"`가 필수다.
  - 백엔드 도구 타입은 `function`·`web_search`만 받는다.
  - `tool_choice`에 `allowed_tools`가 없다.
- 테스트: `uv run pytest -q` 75개 통과(DB 테스트 포함, `TEST_DATABASE_URL`=로컬 pgvector 컨테이너).
- 컨테이너 기동: 이미지를 빌드해 테스트 DB에 붙여 띄움.
  - `/health` 200, `/monitor` 200(인증), 서명 없는 웹훅 400.

### 남은 것
- 실제 연결(범위 밖)
  - 공인 HTTPS·리버스 프록시, OpenAI 프로젝트 웹훅 등록, PBX 트렁크 설정, 실제 통화 확인.
- 실제 통화 전에 확인할 것
  - `delegation.responses.model`(지금 `gpt-6-luna`)이 GPT-Live 위임에서 되는지.
  - strict 스키마의 `maxLength`가 위임 백엔드에서 받아들여지는지.
- RAG(pgvector)
  - 주문 DB와 데이터베이스·계정을 나눌 것.
  - 지금 `ai-db`에는 주문 계정 하나뿐이다.
- 진행 문구·지시문은 실제 통화를 들어 보며 다듬어야 한다(`prompts/`).
- 등록 고객의 받는 순서: 지금은 "지난번 받는 분 질문"만 앞에 둔다. 순서를 바꾸려면 `app/flow/stages/collecting.py`.
- 아직 없는 기능(AGENTS.md "아직 없는 것")
  - 추가 주문에서 앞 주문과 같은 보내는 분 쓰기.
  - 알림톡, 실제 요금 API, 결제, outbound.

## 2026-10-21

### 바꾼 것
- 백엔드 모델 `delegation.responses.model`을 `gpt-5.4-mini`에서 `gpt-6-luna`로 바꿈(사용자 요청). `reasoning.effort`는 그대로 `low`.

### 남은 것
- `gpt-6-luna`가 GPT-Live 위임에서 되는지, `low` effort를 받는지 실제 통화로 확인.

### 바꾼 것(오후: `spec/scenario.md` 적용)
- 단계를 scenario.md대로 다시 정의
  - `collecting` 하나로 합침(신규·등록 고객은 받는 순서만 다름).
  - 새 단계: `recent_offer`, `find_destination`, `find_origin`, `submitted`(머무르지 않고 바로 넘어감).
  - 하위 흐름(조회·수정·취소·상담원)은 `ending`을 뺀 모든 단계에서 들어감.
- 엔진: 상황별 항목 순서(`order`), 결과별 안내 문구(`variants`), 시작 직후 `stage.entered` 평가.
  - 하위 흐름에서 복귀하면 같은 사건을 돌아간 단계가 다시 본다.
- 도구
  - 지움: `find_saved_places`, `use_saved_place`, `use_recent_receiver`.
  - 추가: `answer_recent_order`, `find_destination`, `answer_same_origin`.
  - `record_order`는 주소가 바뀌고 상세 주소를 같이 말하지 않으면 상세 주소를 비움(다시 묻기).
  - 수정·취소는 실패 이유(불일치·이미 취소됨)를 구분.
- DB
  - `saved_places.kind`(origin·destination) 추가.
  - `latest_order` 추가.
  - update·cancel이 `ok`·`not_found`·`cancelled`를 돌려줌.
- 사용자와 정한 것
  - 출발지·도착지는 종류 칸으로 구분.
  - 수정·취소 대조는 주문번호 + 발신번호.
  - 등록 고객에는 지난 주문도 포함.
  - 저장 동의 뒤 새 주문은 등록 고객 시작 규칙(최근 배송 = 방금 접수한 주문).

### 확인한 것
- DB 없이 도는 테스트 92개 통과. scenario.md의 시나리오 10개와 분기별 테스트 포함.

### 남은 것
- DB 테스트 4개는 Docker가 꺼져 있어 못 돌림.
- 이미 만든 DB에는 `kind` 칸이 없다. `CREATE TABLE IF NOT EXISTS`는 기존 테이블을 고치지 않는다.
  - 운영 데이터가 없으니 `saved_places`를 지우고 다시 띄우면 된다.
  - 테스트 DB도 마찬가지.
- 저장된 배송지 검색은 띄어쓰기를 무시한 부분 문자열 비교다. 오타·별칭(예: "센텀" ↔ "센텀시티")은 못 찾는다.


### 바꾼 것(저녁: 고객 답 판별을 도구 호출에서 분리)
- 문제: 고객 답마다 백엔드 도구 왕복을 거쳐야 상태가 바뀌어 지연이 생김(사용자 지적).
- 대화 상태 전환을 서버의 고객 말 판별로 바꿈(`app/listener.py`).
  - 말이 `listener.pause_ms` 동안 멈추면 작은 모델(`responses.create`, JSON 스키마)로 판별한다.
  - 판별 대상: 이 단계의 답 + 끼어드는 용건.
  - 상태가 바뀌면 바로 `thinking.append`.
  - 판별 중 단계가 바뀌었거나 더 새 판별이 있으면 결과를 버린다. 선택지 밖 출력도 버린다.
- 엔진: `Stage.listen`·`choices`·`on_answer` 추가. 답 처리(접수·저장·최근 배송 채우기 등)는 단계 정의로 옮김.
- 도구
  - 지움(8개): `answer_recent_order`, `find_destination`, `answer_same_origin`, `confirm_order`, `save_places`, `next_request`, `transfer_to_agent`, `end_call`.
  - 남김: `get_state`, `record_order`, `lookup_orders`, `modify_order`, `cancel_order`.
- 저장된 받는 곳·출발지 찾기는 저장된 목록을 판별 선택지로 넘겨 모델이 고르게 함. 문자열 비교 검색은 지움.
- 설정 `[listener]`(모델 `gpt-6-luna`, effort low, pause 600ms 등), 문구 `prompts/flow.toml`의 `classifier`.
- 음성 지시문: 예/아니오 같은 답은 백엔드에 맡기지 않음. 백엔드 지시문: 기록·주문 작업만.
- 안전장치 변경(AGENTS.md)
  - 접수·저장·상담원 전환은 그 단계 확인 질문의 판별 결과로 실행.
  - 통화 종료도 고객의 종료 요청 판별로 바로 진행한다(이전에는 확인을 한 번 더 받았음).
  - 수정·취소만 `customer_confirmed`.

### 확인한 것
- GPT-Live `triggers`(decisions)·Decision API는 SDK 타입에는 있으나 공개 문서에 없음. 미확인이라 쓰지 않음.
- 공식 문서 권장 방식(앱이 받아쓰기를 모아 작은 모델로 판별 → `thinking.append`)을 따름.
- 테스트 93개 통과(DB 포함). 테스트 DB는 새 스키마로 다시 만듦.

### 남은 것
- 판별 지연·정확도는 실제 통화로 확인. 조정할 곳: `listener.pause_ms`·모델·effort.
  - 말이 멈추는 기준이 짧으면 말이 끝나기 전에 판별하고, 길면 늦다.
- 판별 모델은 백엔드와 같은 `gpt-6-luna`(사용자 지정). 판별 지연·비용을 실제 통화로 확인.
- 판별은 고객 말 한 덩어리마다 모델을 한 번 부른다. 비용 확인 필요.

## 2026-10-21 (계획 변경: PostgreSQL 제거, 백엔드 API, Qdrant)

### 바꾼 것
- PostgreSQL을 쓰지 않음
  - 지움: `app/db.py`, `app/schema.sql`, `tests/test_db.py`, psycopg 의존성, compose의 `ai-db`.
- 고객·주문·배송지는 별개의 백엔드 서버 API로 읽고 씀(사용자 결정).
  - API 제안서: `spec/backend-api.md`.
  - 클라이언트: `app/backend_api.py`(`openai`에 딸린 `httpx2`, `BACKEND_API_URL`).
  - 통화 시작 때 한 번에 받는 것: 최근 배송, 저장된 배송지(종류별).
  - 접수번호는 백엔드가 발급. 접수 요청에 `Idempotency-Key`(`세션-n번째`)로 재요청 중복을 막음.
  - 전화번호는 URL에 넣지 않고 본문으로. 경로의 접수번호는 인코딩(`../` 차단).
- 코드 이름 `db` → `backend`. 설정 `[storage]` → `[backend]`(timeout_sec 추가, 풀 크기 제거). `order_prefix` 제거(번호 형식은 백엔드).
- 판별한 답 처리 중 백엔드가 실패하면(접수·저장 등): 상태는 그대로 두고 음성 모델에 오류 안내(`prompts/flow.toml` `answer_error`).
- Qdrant: `ai/compose.yaml`에 서비스만 추가(`qdrant/qdrant:v1.13.4`, internal 네트워크, 볼륨, `QDRANT_API_KEY`). 컬렉션·코드는 RAG 담당자 몫.
  - `docs/rag-handoff.md`를 Qdrant 기준으로 다시 씀.
- 문서: AGENTS.md(스택·저장·안전장치·표), spec(concurrency·monitor·server-config·tools·scenario).

### 확인한 것
- `openai` 3.35는 `httpx`가 아니라 `httpx2`에 의존한다. FastAPI 테스트 클라이언트도 이걸로 동작한다.
- 테스트 98개 통과. 백엔드 API 클라이언트는 가짜 HTTP 전송으로, 흐름은 가짜 백엔드로 시험.
- Qdrant 태그 `v1.13.4` 존재 확인. compose 설정 검증 통과.

### 남은 것
- 백엔드 담당자가 정할 것: API 확정, 인증 방식, 접수번호 형식, 요금 계산 주체, 응답 속도 목표.
  - 통화 시작 조회는 accept 전이라 빨라야 함.
- 인증이 정해지면 `app/backend_api.py`에 헤더, compose·`.env.example`에 변수 추가.
- 백엔드 API가 없으면 통화는 신규 고객으로 시작하고 접수가 실패한다. 실제 통화 전에 백엔드가 떠 있어야 함.

### 바꾼 것(PBX 통화 종료 웹훅)
- 사용자 요구: 통화가 끝나면 웹훅이 와서 세션을 종료해야 함. OpenAI에는 통화 종료 웹훅이 없음(SDK 확인). 그래서 PBX가 보내는 것으로 정함(사용자 결정).
- `POST /pbx/webhook/call-ended`(`app/pbx.py`)
  - SIP Call-ID로 통화를 찾아 바로 hangup.
  - 서명: HMAC-SHA256 + 타임스탬프, 비밀값 `PBX_WEBHOOK_SECRET`.
  - accept 중에 오면 accept가 끝나는 대로 끊고 sideband는 열지 않음.
- 통화 객체에 `sip_call_id`·`pbx_ended`, 레지스트리에 Call-ID 조회.
- 설정 `[pbx] webhook_tolerance_sec`. compose·`.env.example`에 `PBX_WEBHOOK_SECRET`.
- `spec/pbx-sip.md`에 PBX 쪽에 전달할 형식(제안)을 씀.

### 확인한 것
- 테스트 103개 통과(`tests/test_pbx.py`: 정상 종료·중복·모르는 통화·accept 중 종료·서명 오류·비밀값 없음).

### 남은 것
- PBX 담당자에게 형식 전달·확정.
- PBX가 보는 Call-ID와 OpenAI 웹훅 `sip_headers`의 Call-ID가 같은지 실제 통화로 확인.
- `ai/.env`에 `PBX_WEBHOOK_SECRET` 추가(PBX와 같은 값).
- 리버스 프록시에서 `/pbx/webhook/call-ended` 공개.

## 2026-10-22 (상태 엔진을 LangGraph로)

### 바꾼 것
- 사용자 결정: 시나리오 분기 구조에 LangChain 계열을 쓴다. LLM 호출은 openai SDK 그대로(gpt-live-1, gpt-6-luna).
  - 그래서 쓰는 것은 `langgraph`(`StateGraph`) 하나. `langchain`·`langchain-openai`는 넣지 않음.
- 의존성: `langgraph>=1.2.16` 추가(langchain-core·langsmith 등이 따라와 lock 패키지 29 → 53개).
- `app/flow/engine.py`: 전이 실행부(`start`·`apply`)를 LangGraph 그래프 실행으로 바꿈.
  - 기동 시 `engine.build()`가 단계 정의로 그래프를 만든다(단계 = 노드, `check_definitions`에서 검증 뒤).
  - 사건 하나 = `ainvoke` 한 번. 노드(`_step`)가 전이(가드)를 보고 `Command(goto=…)`로 옮김.
  - 그래프 상태(`Step`)는 단계·사건·도구 이름뿐. 통화 객체는 `context`로 넘김. 체크포인터 없음.
  - `MAX_HOPS`는 `recursion_limit`(`MAX_HOPS + 1`)로. 넘으면 지금처럼 `FlowError`.
  - 노드마다 `destinations`를 적어 `get_graph().draw_mermaid()`로 흐름도를 만들 수 있게 함.
- `start`·`apply`가 async가 되어 호출부 4곳에 await(`app/call.py`, `app/dispatcher.py`, `app/listener.py` 2곳).
- 단계 정의(`app/flow/stages/`), 도구, 디스패처, 판별기, FastAPI는 그대로.
- 문서: `spec/flow.md`(엔진 = LangGraph, 실행 방식·규칙), `spec/concurrency.md`(그래프 공유·async 노드), AGENTS.md(스택·구조·안전장치에 LangSmith 추적 끔).

### 확인한 것
- langgraph 1.2.16: openai 3.35.1·Python 3.14와 충돌 없이 설치.
- 실행으로 확인한 동작(스크래치 예제)
  - `ainvoke`에서 동기 노드·동기 라우터는 다른 스레드에서 돈다. 그래서 노드·라우터는 모두 async.
  - `context`로 임의 객체(통화 객체)를 넘길 수 있다(`context_schema` 없이).
  - `recursion_limit=L`이면 노드 실행 L-1번까지만 된다.
- 오버헤드: 사건 하나에 약 0.8~1.4ms(전이 1~4번).
- 테스트 106개 통과
  - 기존 103개는 시나리오 데이터를 고치지 않고 그대로 통과.
  - 추가 3개: 흐름도 엣지가 전이·하위 흐름·복귀를 모두 그리는지, `MAX_HOPS` 한도(4번 이동은 되고 5번째에서 `FlowError`).
- 실제 단계로 만든 그래프: 노드 15개(START·END 포함), 엣지 132개.
- 이전 엔진과 비교(일회성 스크립트, 저장소에 넣지 않음)
  - 이전 엔진(HEAD)과 새 엔진에 같은 무작위 통화 1,800개(행동 41,064개)를 넣음.
  - 행동마다 단계·복귀 단계·전이 기록·임시 주문·도구 결과가 모두 같았음.
  - 13개 단계를 모두 지나갔고, 서로 다른 전이는 138가지.
  - 비교가 실제로 차이를 잡는지도 확인: 이전 엔진의 "복귀 후 같은 사건 다시 보기"를 일부러 끄자 불일치를 잡음.
- Docker 데몬이 꺼져 있어 이미지 빌드는 못 함. 대신 잠긴 런타임 패키지 46개가 Linux x86_64·Python 3.14 바이너리 wheel만으로 설치되는 것을 확인(`uv pip install --dry-run --only-binary :all:`).

### 남은 것
- Docker 이미지 빌드·기동 확인(데몬을 켜고 `docker compose build`).
- 실제 통화로 회귀 확인(분기 동작은 그대로여야 함).
- (선택) 관제 화면에 흐름도(mermaid) 보여 주기.

### 바꾼 것(LangGraph Studio)
- 사용자 결정: 시나리오 분기를 직관적으로 보도록 LangGraph Studio를 세팅(관제 화면 흐름도 대신).
- dev 의존성 `langgraph-cli[inmem]`(lock 패키지 53 → 88개, 운영 이미지는 `--no-dev`라 영향 없음).
- `langgraph.json`: 그래프 `call_flow` = `studio/graph.py:graph`, `LANGSMITH_TRACING=false` 고정.
- `studio/graph.py`(개발 전용, 이미지·Docker 빌드 컨텍스트에서 뺌)
  - 스레드 하나 = 가짜 통화 하나. 실행마다 보고 하나(customer로 시작, 그다음 answer·intent·tool 중 하나).
  - 보고 처리는 실제 코드(`call.prepare`, `listener.apply_answer`, `dispatcher.dispatch`)를 그대로 부르고, `engine.apply`를 잠시 바꿔 사건만 모음.
  - 모은 사건을 실제 엔진 노드(`engine._step`)로 단계 노드마다 흘려보내 Studio에서 경로가 노드별로 보임.
  - 결과: 단계·다음 질문·답 선택지·허용 도구·기록된 값·`record_order` 예시 인수·지나온 경로.
  - 고객 상황·가짜 백엔드는 테스트의 것을 그대로 씀.
- `.gitignore`·`.dockerignore`에 `.langgraph_api/`(dev 서버 상태) 추가.
- 문서: `spec/flow.md`("LangGraph Studio로 보기"), AGENTS.md(dev 의존성, 문서 표, 추적 고정).

### 확인한 것
- 공식 문서
  - Studio 화면은 smith.langchain.com에서 로컬 서버(`baseUrl`)로 붙는다.
  - `LANGSMITH_TRACING=false`면 데이터가 로컬 서버 밖으로 나가지 않는다.
  - Studio 연결에 LangSmith API 키가 필요하다고 되어 있다.
- 한국어 Windows에서 `langgraph dev`는 cp949 때문에 기동 실패 → `PYTHONUTF8=1`로 해결.
- 실제 `langgraph dev`(Python 3.14)를 띄워 HTTP API로 확인
  - 스레드를 만들고 한 통화(시작 → 기록 → 접수 → 저장 거절 → 종료)를 실행함.
  - 스레드에 상태가 이어지고, 노드가 report → 단계 노드들 → done 순서로 기록됨.
  - LangSmith API 키 없이도, `.env` 없이도 서버가 뜸.
- 테스트 119개 통과
  - 추가 13개(`tests/test_studio.py`): 시나리오 12건이 Studio 그래프에서도 같은 경로.
  - 한 실행에서 단계 노드가 하나씩 지나가는지, 잘못된 입력은 오류 결과로 돌려주는지.

### 남은 것
- Studio 웹 화면 연결은 사용자 계정으로 확인(LangSmith 로그인 필요, 키가 필요하면 `LANGSMITH_API_KEY` 환경변수).
- Studio의 되감기·포크는 가짜 통화에 반영되지 않음(새 스레드로 다시 시작).

## 2026-10-22 (AI 서버 Lightsail 인스턴스: Jenkins 설치)

### 바꾼 것
- Lightsail(Ubuntu 24.04, x86_64, RAM 16GB) 인스턴스에 설치: Docker Engine 29.9 + compose plugin(Docker 공식 apt 저장소), OpenJDK 21, Jenkins LTS 2.580.1(공식 apt 저장소).
- `jenkins`·`ubuntu` 사용자를 `docker` 그룹에 넣음(Jenkins가 `docker compose` 직접 실행).
- nginx·certbot은 하지 않기로 함(HTTPS 불필요하다고 사용자 결정).
- `ai/Jenkinsfile`: `develop-ai` push(GitLab 웹훅) → 작업공간의 `ai/`에서 `docker compose --env-file /srv/dva-ai/.env up -d --build --wait`. 루트 `Jenkinsfile`(팀 CI)은 건드리지 않음.
- 서버에 `/srv/dva-ai/.env`(jenkins 소유, 600, 빈 파일) 생성. 값은 사용자가 채운다.
- Jenkins URL `http://3.37.162.168:8080/` 확인, 역방향 프록시 경고(`ReverseProxySetupMonitor`) 끔(프록시 없음).
- Jenkins job `dva-ai-deploy` 생성(일회용 init Groovy, 실행 후 삭제): SCM `develop-ai`, Script Path `ai/Jenkinsfile`, 자격 증명 ID `gitlab-ssafy`, GitLab push 트리거(`develop-ai`만, 비밀 토큰은 서버 `/root/dva-ai-webhook-token`).
- 확인: 맞는 토큰 200, 틀린 토큰 401, 다른 브랜치 push는 빌드 안 됨.
- job `dva-ai-deploy`는 일단 비활성화(사용자 요청). 사용자가 직접 돌린 #1은 GitLab 인증 실패(토큰 대신 비밀번호로 추정).
- 서버 시간대 Asia/Seoul. `compose.yaml`의 `ai`에 `TZ: Asia/Seoul`(python:3.14-slim에 tzdata 있음 확인). 앱 코드에 로컬 시각 의존은 없어 로그 시각만 바뀐다.
- nginx 1.24 설치. 80은 열림, 443은 닫힘.
- 사용자가 IP 주소용 Let's Encrypt 인증서 발급(`/etc/letsencrypt/live/3.37.162.168`, `shortlived` 6일, webroot 갱신). nginx를 80(인증 경로 + 나머지 HTTPS로 301)·443(프록시, SSE 버퍼링 끔) 두 블록으로 정리. 갱신 후 `systemctl reload nginx` 하는 deploy hook 추가. `certbot renew --dry-run` 성공.
- 확인: 밖에서 HTTPS 인증서 검증 통과(앱이 없어 502). 443은 사용자가 Lightsail 방화벽에서 엶.
- 인증서를 발급 후 3일째 갱신: 갱신 설정에 `renew_before_expiry = 88 hours`(수명 160시간 - 72시간). snap 타이머가 하루 두 번(03:23, 19:36 KST)이라 실제 갱신은 3일 경과 후 첫 타이머. 첫 갱신 예상 2026-10-25 19:36.
- certbot은 snap 5.8.0만 남김(apt 2.9.0은 purge, `/usr/bin/certbot` → `/snap/bin/certbot` 링크). 갱신 타이머는 `snap.certbot.renew.timer` 하나.
- nginx `sites-available/default`를 server 블록 하나로 정리(기본 블록 안에 새 설정이 붙어 `duplicate listen` 오류였음, 원본은 서버 `/root/nginx-default.bak.*`): `/.well-known/acme-challenge/` → `/var/www/certbot`, 나머지 → `127.0.0.1:8000`, `/monitor/api/stream`은 버퍼링 끔. 확인: 인증 경로 응답, `/`는 앱이 없어 502.

### 확인한 것
- Jenkins apt 저장소 서명 키가 `jenkins.io-2026.key`(지문 `5E386EADB55F01504CAE8BCF7198F4B714ABFC68`)로 바뀌어 있음. 2023 키로는 `NO_PUBKEY 7198F4B714ABFC68`.
- `jenkins` 사용자로 `docker ps` 성공. Jenkins는 8080에서 대기, 외부에서는 Lightsail 방화벽에 막혀 닿지 않음.

### 남은 것
- `/srv/dva-ai/.env` 값 채우기, Jenkins 자격 증명 `gitlab-ssafy` 등록, GitLab 웹훅 등록, `ai/Jenkinsfile`을 `develop-ai`에 반영, 첫 배포 확인.
- Jenkins 로그에 `github-branch-source` 플러그인 로드 실패가 있음(쓰지 않음, 배포와 무관).
- 배포 전 테스트 stage 없음(서버에 uv 없음). 필요하면 추가.
- OpenAI 웹훅은 공인 HTTPS 주소가 필요함. TLS를 어디서 처리할지 확인 필요.

## 2026-10-26

웹훅 주소·PBX 종료 웹훅·`app/` 구조 정리, LangGraph 브랜치 머지, Jenkins CI·Lightsail 배포. 아래는 하루가 끝난 시점(`develop-ai` `6d3b148`)의 최종 상태 기준.

### 바꾼 것
- 웹훅 주소(`3d81a32`)
  - 전화 수신(OpenAI가 보냄): `POST /openai/webhook` → `POST /api/webhooks/openai/call-incoming`.
  - 통화 종료(PBX가 보냄): `POST /pbx/webhook/call-ended` 그대로. 백엔드 서버가 보내게 바꾸려다 취소.
  - `.gitignore`에 `.langgraph_api/`(LangGraph Studio 개발 서버 상태).
- 브랜치
  - `refactor/langchain` → `refactor/langgraph`로 이름 바꿔 푸시, `develop-ai`에 머지. 원격 `refactor/langchain`·`refactor/langgraph`는 머지 때 삭제됨.
  - GitLab에서 `WORKLOG.md` 충돌을 풀며(`a7eac34`) 위 웹훅 주소 기록이 빠졌다. 이 항목으로 되살림.
- `app/` 웹훅 정리(`716ea24`)
  - `app/webhook.py` → `app/webhooks/openai.py`, `app/pbx.py` → `app/webhooks/pbx.py`.
  - 앱 공용 객체 `Services`를 `app/services.py`로. PBX 종료 때 세션 끊기를 `sideband.hangup_now`로 옮겨 함수 안 import(순환 회피)를 없앰.
- PBX 통화 종료 웹훅(`b481289`): PBX가 팀 백엔드에 보내는 것과 같은 본문을 우리에게도 보낸다.
  - 인증: HMAC 서명(`X-Pbx-*`) → `Authorization: Bearer <PBX_WEBHOOK_SECRET>`(상수 시간 비교). `[pbx] webhook_tolerance_sec` 삭제.
  - 본문: PBX 형식(`callFrom`·`endedAt` 필수, `recordingId` 기록, `recordingUrl` 등 나머지 무시).
  - 통화 찾기: SIP Call-ID가 없어 발신번호로. `endedAt` 전에 시작한 진행 중 통화만 끊는다(웹훅이 녹취 준비 뒤 몇 초 늦게 와서, 그사이 같은 번호로 다시 건 통화를 보호).
  - SIP Call-ID 수집 코드 삭제. 발신번호 정규화를 `call.normalize_phone`으로 빼서 SIP `From`과 `callFrom`이 같이 씀.
- Jenkins CI·배포(`18ff124` `6114b5b` `13334bf` `20edfa5` `1ae73a8` `e3e6ebc`)
  - 예전 `ai/Jenkinsfile`은 `agent any`라 레이블 전용 노드만 있는 팀 Jenkins에서 대기열에 머물렀다. 팀 최신 Jenkinsfile을 바탕으로, 백엔드 Jenkinsfile(`develop-backend`) 방식에 맞춤.
  - 흐름: `linux-docker-builder` 노드 → 이미지 빌드(`dva-ai-server:<커밋12자리>-<빌드번호>`, linux/amd64) → 그 이미지 안에서 pytest → 접속 확인(`--verify-only`) → `DEPLOY_LIGHTSAIL`을 체크했을 때만 배포.
  - 자격 증명: SSH는 백엔드와 같은 `dva-lightsail-ssh`, 비밀값은 Jenkins Secret file `dva-ai`. 배포 때 서버의 `/home/ubuntu/dva-ai/shared/.env`(600)로 올린다.
  - `ai/deploy/upload.sh`: 고정 호스트 키(`deploy/known_hosts`, `StrictHostKeyChecking=yes`)로 `13.209.59.180`에 SSH. 이미지는 `docker save | docker load`, 릴리스(`compose.yaml`·`config/`·`prompts/`·`deploy.sh`·`compose.deploy.yaml`·`release.env`)는 `releases/<version>`에.
  - `ai/deploy/deploy.sh`(서버): `docker compose --project-name dva-ai up --no-build --pull missing --wait`. 성공하면 현재·직전 릴리스 기록, 그 두 이미지만 남김. 실패하면 직전 릴리스로 복구. `sudo -n docker`, `flock`.
    - `--pull never`였을 때 서버에 Qdrant 이미지가 없어 빌드 #12 배포가 실패했다 → `--pull missing`(AI 이미지는 미리 load 해 두므로 받지 않음).
  - 백엔드와 연결: 백엔드(`ci/backend-external-ai`)가 정한 외부 네트워크 `dva-prod_ai_net`에 별칭 `ai`로 붙는다(`compose.deploy.yaml`, 배포 때만). 백엔드 → `http://ai:8000`, AI → `BACKEND_API_URL`(`http://backend:3000`).
    - 새 AI가 정상 기동하면 백엔드 스택이 띄웠던 예전 `dva-prod-ai-1`을 멈춘다(지우지 않음, `docker start`로 되살릴 수 있음).
  - `compose.yaml`: `ai`에 `image: ${AI_IMAGE:-dva-ai:local}`, 호스트 포트 `${AI_PORT:-8000}`. `.env.example`에 `AI_PORT`, `.dockerignore`에 `deploy`.
  - 이미지 이름은 `dva-ai-server`(백엔드가 빌드하던 `dva-ai`와 겹치지 않게). 다른 관리자의 서버라 `docker image prune`은 쓰지 않음.
- 문서: `spec/pbx-sip.md`(두 웹훅 구현 경로, 종료 웹훅 절), `docs/rag-handoff.md`(`Services` 위치).

### 확인한 것
- `develop-ai`(`6d3b148`)에서 `uv run pytest -q` 120개 통과, 두 배포 스크립트 `bash -n` 통과.
- 앱 기동·웹훅 응답: `/health` 200, 수신 웹훅 서명 없음 400, 옛 주소 `/openai/webhook` 404.
- `docker compose config`(가짜 env)로 `compose.yaml` + `compose.deploy.yaml` 병합과 `AI_IMAGE`·`AI_PORT` 치환.
- `deploy.sh`를 가짜 docker로 시험: 첫 배포, 두 번째 배포(직전 기록·이미지 정리), 실패 시 직전 릴리스 복구.
- PBX 담당 회신
  - 회사 번호를 OpenAI 프로젝트로 넘기는 SIP 설정 완료.
  - 통화 종료 웹훅 본문: `recordingId`·`callFrom`·`callTo`(두 070 번호 구분)·`startedAt`·`endedAt`·`durationSeconds`·`recordingUrl`. 녹취가 준비된 뒤 보내 끊긴 시점보다 몇 초 늦다.
  - 재전송: 2xx가 아니거나 연결 오류·30초 타임아웃이면 5초 간격 최대 5번. 리다이렉트는 따라가지 않는다 → 주소는 정확히 `https://…/pbx/webhook/call-ended`(끝 `/` 없음, `http` 아님). 우리 서버는 모르는·끝난 통화에도 200, 중복은 한 번만 처리.

### 남은 것
- OpenAI 프로젝트에 웹훅 `https://<도메인>/api/webhooks/openai/call-incoming` 등록(`live.transport.incoming` 구독), `OPENAI_WEBHOOK_SECRET`을 Jenkins `dva-ai`에.
- 호스트 Nginx(백엔드 담당)에서 `/api/webhooks/openai/call-incoming`·`/pbx/webhook/call-ended`를 AI(`127.0.0.1:${AI_PORT}`)로.
- PBX 담당에 우리 종료 웹훅 주소와 Bearer 토큰(`PBX_WEBHOOK_SECRET`과 같은 값) 전달, 우리 쪽 발송 설정 확인.
- 실제 통화로 확인
  - PBX `callFrom`이 OpenAI 웹훅 SIP `From`의 발신번호와 같은지(다르면 종료 웹훅이 통화를 못 찾는다).
  - 고객이 먼저 끊으면 sideband `session.closed`(`remote_hangup`)가 바로 오는지.
- Jenkins `DEPLOY_LIGHTSAIL` 배포가 끝까지 성공하는지(#12 이후 `--pull missing` 반영본), 백엔드 → AI(`http://ai:8000`)·AI → 백엔드 호출 확인.

## 2026-10-26 (첫 배포, 웹훅 연결, 실제 통화)

위 "남은 것"을 처리한 기록. 서버 설정(호스트 Nginx·인증서)은 저장소가 아니라 서버에서만 바꿨다.

### 바꾼 것
- 첫 배포: Jenkins `dva-ai` #14(`DEPLOY_LIGHTSAIL`, `6d3b148a517a-14`) 성공.
  - Qdrant 이미지를 서버에서 처음 받음(`--pull missing`).
  - `dva-ai-ai-1`이 `dva-prod_ai_net`에 별칭 `ai`로 붙고, 예전 `dva-prod-ai-1`은 멈춤(지우지 않음). 되돌리기: `sudo docker stop dva-ai-ai-1 && sudo docker start dva-prod-ai-1`.
- 호스트 Nginx(`/etc/nginx/sites-available/dva-ip`, 원본은 백엔드 `infra/https/https.conf`). 고칠 때마다 `/root/dva-ip.bak.*`로 백업.
  - `POST /api/webhooks/openai/call-incoming`, `POST /pbx/webhook/call-ended` → AI(`127.0.0.1:8000`). 기존 PBX 웹훅 블록과 같은 형식(POST만, 본문 16k, 10초).
  - PBX는 백엔드 주소(`/api/webhooks/pbx/call-ended`)로만 보내고, 백엔드는 DB에 저장만 하고 AI에 넘기지 않는다. 그래서 그 경로에 `mirror`를 달아 같은 요청(본문·Bearer 토큰)을 AI `/pbx/webhook/call-ended`로 복사. PBX가 받는 응답은 백엔드 응답 그대로. 백엔드 `PBX_WEBHOOK_TOKEN`과 우리 `PBX_WEBHOOK_SECRET`이 같은 값이라 인증도 통과(해시로만 비교).
- OpenAI 웹훅 주소를 `https://13-209-59-180.sslip.io/api/webhooks/openai/call-incoming`으로.
  - `https://13.209.59.180/...`(IP 주소 URL)로는 테스트 전송이 "Failed to POST to webhook endpoint"였고, 서버 443에 TCP 연결(SYN)조차 오지 않았다(tcpdump, 테스트 3번).
  - 같은 서버를 이름(sslip.io: 이름에 적은 IP를 돌려주는 공개 DNS)으로 바꾸자 바로 `9.129.x.x`에서 연결이 왔다. OpenAI가 IP 주소 URL로는 보내지 않는 것으로 본다(공식 문서에서는 못 찾음).
  - Let's Encrypt 인증서 `dva-sslip`(webroot, 기존 갱신 타이머·nginx reload 훅 그대로) 발급. 이 이름의 443 블록은 전화 수신 웹훅만 열고 나머지는 404.

### 확인한 것
- 백엔드 → AI: 백엔드 컨테이너에서 `ai`가 새 컨테이너 IP 하나로만 풀리고 `/health` 200.
- 실제 통화 2번: 수신 웹훅 200 → accept 200 → 통화 → 고객이 끊음 → PBX 종료 웹훅(mirror) 200 → 약 2.5초 뒤 sideband 종료로 `ended`(`remote_hangup`). 남는 세션 없음.
  - PBX `callFrom`으로 통화를 찾았다(`pbx_ended` 기록됨). 발신번호 형식은 맞다.
  - 종료 웹훅 뒤의 `hangup`은 이미 닫힌 세션이라 404. 동작에는 문제없고 모니터에 오류로만 남는다.
- 테스트 전송 이벤트(`live_u0_abc123`)는 서명 검증까지 통과하고 accept만 503(없는 세션).

### 남은 것
- 백엔드에 `POST /internal/ai/callers/context`가 없어 404("고객 조회 실패"). 통화는 최근 주문·배송지 없이 진행된다. 주문 저장 등 다른 백엔드 API도 같은지 백엔드 담당과 확인.
- 호스트 Nginx 변경(AI 웹훅 경로, mirror, sslip.io 블록)을 백엔드 저장소 `infra/https/https.conf`에도 반영. 안 하면 그 파일로 다시 설치할 때 사라진다.
- `hangup_now`에서 404를 "이미 끝남"으로 처리해 오류로 남기지 않기.
- Jenkins credential `dva-ai`의 `.env`가 CRLF. compose는 읽지만 셸에서 `source`하면 값 끝에 `\r`이 붙는다. LF로 다시 올리기.
- sslip.io는 외부 무료 서비스(보장 없음). 오래 쓸 거면 정식 도메인으로.
- PBX 종료 웹훅 토큰을 바꿀 때는 백엔드와 AI 값을 함께 바꾸기(다르면 AI 쪽 mirror만 조용히 401).

## 2026-10-27

### 바꾼 것
- 고객 답 판별 지연 측정(`app/listener.py`, `app/call.py`)
  - 마지막 받아쓰기 조각 시각(`heard_at`)부터 진행 상태를 보낼 때까지를 `total_ms`로 판별 기록에 남김. 멈춤 대기(`pause_ms`) + 판별 모델 + 답 처리(접수 등)를 모두 포함.
  - 판별마다 INFO 로그 한 줄: 단계·answer·intent·모델 시간(`elapsed_ms`)·`total_ms`·진행 상태가 바뀌었는지. 고객 말은 로그에 남기지 않음.
  - 관제 화면 도구 목록의 listener 항목에 "말 끝→진행 상태" 시간 표시.

### 확인한 것
- `uv run pytest -q` 120개 통과(판별 테스트에 `total_ms ≥ elapsed_ms` 확인 추가).

### 남은 것
- 실제 통화로 판별 지연 측정(`docker logs`에서 `판별` 줄, 또는 관제 화면). 결과에 따라 판별 모델·reasoning·`pause_ms` 조정.
- PoC 발화 자산 이식(voice.md·flow.toml·backend.md), 저장된 값 가림, 확인 단계 "아니요" 변형 문구, 종료 판별 확인.

### RAG 전화 통합 브랜치 준비 — S15P31D109-122

요청: 최신 develop-ai 위에서 검증한 RAG를 실제 수신 통화에 연결하고, 실험 잔여 코드를 정리한 뒤 커밋/병합 검토를 준비한다. develop-ai에 직접 병합·푸시·배포하지 않는다.

- 최신 origin/develop-ai `2b111f6`로 로컬 develop-ai를 fast-forward하고 `feature/S15P31D109-122-rag-call-integration`을 만들었다. 마무리 fetch에서도 원격은 같았다.
- 기존 feature/S15P31D109-122-rag-llm-context HEAD b9fbb9e와 미커밋 작업은 stash3c3cb3b 및 private ZIP에 보존했다. 기존 stash2개도 유지했다. stash를 새 develop에 통째로 덮지 않고 필요한 파일만 선택했다.
- 팀원 변경(LangGraph/Studio, services/webhooks 분리, PBX 종료 인증, 판별 지연, 자동 배포)을 확인·유지했다. RAG가 없던 운영 브랜치에 검색/분할/임베딩만 LangChain으로 추가하고 LLM은 SDK를 유지했다.
- 운영 RAG: 통합 Q+A large3072 Cosine, Kiwi/BM25+vector 0.4/0.6 가중 RRF c60 Top5, 고정 Qwen3-Reranker-0.6B 원문A/FP16/1024토큰, 원문 Top3. 알고리즘은 app/rag에 두고 운영 코드의 scripts 의존을 제거했다. PDF/HTML/질문 전용/C/BGE 비교·모델 가중치는 통합 대상에서 제외했다.
- Live 기본을 client 위임으로 변경했다. 최근 전사+현재 상태를 SDK backend에 보내 도구를 한 번 선택하고 기존 디스패처로 실행한다. 반환 근거는 다시 backend 답변 생성에 보내지 않고 Live thinking 조각+ACK+commentary로 직접 전달한다. 기존 responses 경로는 복귀용으로 유지하며 그 경우 function_call_output/response.create 규칙도 유지한다.
- 검색은 주문 상태/상담원 연결을 바꾸지 않는다. 중복 위임 방지, 새 위임의 옛 검색 취소, 늦은 결과 차단, 이미 시작한 쓰기의 재실행 방지, 통화별 ACK/정리, 검색/전달 실패 후 안내를 추가했다. 단계별 도구 권한·발신번호·확인 안전장치는 유지했다.
- backend 선택/검색·임베딩·DB·리랭킹·맥락 전달 시간을 남긴다. 근거 뒤 첫 패킷/전사도 관측하되 정답 안내 시작/고객 재생 완료로 부르지 않는다.
- 사용자가 GPU를 직접 준비하기로 했으므로 외부 /rerank 코드·인증·모델 버전/ID/점수 검증을 준비했다. RunPod과 Google Cloud 모두 같은 계약이다. 전화 이미지에는 torch를 넣지 않는다. 실제 외부 GPU는 미연결이다.
- 사용자 추가 결정: 3,500원 고정 요금 삭제. 미확정 fare 전송과 확정 안내도 제거했다. 백엔드는 우선 유인 기준 서류3,850/소박스4,950/중박스6,050/대박스7,150원을 계산한다. 현재 AI 주문에는 별도 규격이 없으므로 규격 입력/전달과 backend fare 생략 수용·확정 금액 응답 계약을 맞춰야 한다. 임의 금액이나 가격 API를 만들어 대신하지 않았다.
- 공개 원문 manuals/, 평가 데이터 evaluation/datasets/, 과거 집계·실제 Live 전사95개·근거·점수 evaluation/results/를 공유한다. 대용량 원시 실행/오디오/모델/비밀은 data/private에 보존하고 Docker context에서도 제외했다.
- 기존 평가: Live RRF Recall5=95/95, Qwen Recall3=95/95, Hit1=92/95, MRR0.982456. Faithfulness0.857882, ContextPrecision0.989474, ContextRecall0.989474, Factual F1=0.721368. Relevancy0.482527은 보조 기록으로 둔다. 기준 답변 자체의 Relevancy도 평균0.521229이고0.8기준8/95만 통과해 보편적 합격선으로 쓰지 않았다. 의미/한계/오답 사례·지연 범위는 evaluation/results/analysis.md에 정리했다.
- Windows CRLF와 manifest의 LF 해시가 달랐던 재현 문제를 발견했다. 과거 cases 바이트/점수를 보존하고 raw/내용 해시를 구분했다. 새 생성은 LF 바이트로 고정하고 .gitattributes로 공유 원문/평가 바이트를 보존한다.
- 검증: 전체191 passed(7.46초), compileall, FAQ32개 dry-run, 평가95문항/근거/해시 검사 성공. Docker Linux/Python3.14 이미지 빌드 성공. --network none 실행으로 SDK 세션 구성, Kiwi, 캐시 토크나이저, FAQ32개, torch/scripts/data 부재를 확인했다. Docker credential 도우미 PATH 누락은 실행 프로세스 PATH만 보완해 해결했다.
- docs/rag-handoff.md, spec/rag.md 및 관련spec, work.md, AGENTS 팀 규칙을 갱신했다. 기존95문항은 이전 실험이며 이번 통합/외부 GPU/실제 전화 평가를 새로 한 것이 아니다. .env는 읽거나 고치지 않았다.

남은 운영 확인: 외부 GPU URL/키와 서버 용량·왕복 지연, 배포 서버 Qdrant의 원문 동일 색인, 규격/요금 백엔드 계약, 실제 전화 FAQ 끼어들기/정정/취소 상태/상담원 동의/장애 회귀. develop-ai 병합 시 자동 배포가 가능하므로 완료를 확인한 뒤 반영한다.
