# 매뉴얼 RAG 인계 문서 (Qdrant)

통화 중 고객 질문(요금·포장·배송 가능 물품 등)에 매뉴얼을 찾아 답하는 RAG를 붙이기 위한 인계 문서다.
**지금 있는 것은 compose의 Qdrant 서비스뿐이고, RAG 코드는 하나도 없다.** 아래 순서대로 만들면 된다.
작업 전에 `AGENTS.md`(작업 규칙·안전장치)와 `spec/`을 먼저 읽는다.

## 1. 정해진 것

- 벡터 DB는 **Qdrant**. PostgreSQL·pgvector는 쓰지 않는다.
- 고객·주문·배송지는 AI 서버가 저장하지 않고 **별개의 백엔드 서버 API**로 읽고 쓴다(`spec/backend-api.md`). 그래서 Qdrant에는 **매뉴얼만** 들어간다. 개인정보(이름·전화번호·주소·받아쓰기)는 넣지 않는다.
- Qdrant는 `ai/compose.yaml`에 이미 있다.

  ```yaml
  qdrant:
    image: qdrant/qdrant:v1.13.4
    environment:
      QDRANT__SERVICE__API_KEY: ${QDRANT_API_KEY:?Set QDRANT_API_KEY in .env}
    volumes:
      - qdrant_data:/qdrant/storage
    networks:
      - rag_net          # internal 네트워크. 밖으로 포트를 열지 않는다
  ```
  - `ai` 서비스도 `rag_net`에 붙어 있다. 컨테이너 안에서 `http://qdrant:6333`(REST)·`6334`(gRPC)로 접근한다.
  - API 키는 `ai/.env`의 `QDRANT_API_KEY`(`.env.example`에 키 이름 있음). `.env`는 사용자가 채운다. 에이전트는 읽거나 고치지 않는다.
  - 버전을 올리면 `docker manifest inspect qdrant/qdrant:<태그>`로 태그가 있는지 확인하고, 데이터 호환(스냅숏)을 확인한다.

## 2. 아직 정할 것 (RAG 담당자)

1. 매뉴얼 원본: 형식(PDF·MD·웹), 위치, 갱신 주기, 버전 관리
2. 임베딩 모델과 차원(예: OpenAI `text-embedding-3-small` = 1536차원). `openai` 패키지가 이미 있다.
3. 청크 나누기 기준(크기·겹침·제목 유지)
4. Qdrant 접근 방식
   - REST를 `httpx2`로 직접 부르기: `openai`에 딸려 있어 의존성 추가가 없다. AGENTS.md "의존성 최소"에 맞는다.
   - `qdrant-client` 패키지 쓰기
   - 추가하면 `pyproject.toml`·`uv.lock`·AGENTS.md 스택 목록을 같이 고친다.
5. 통화 중 언제 검색하고 어떻게 답할지(5장)
6. 검색 결과 개수·점수 하한, 못 찾았을 때의 안내(상담원 연결 제안 등)
7. 백업: 원본에서 다시 색인할 수 있으면 백업 없이 재색인. 아니면 Qdrant 스냅숏.

## 3. 권한 분리 (권장)

- 색인(쓰기)과 통화 서버의 검색(읽기)을 다른 키로 나눈다. Qdrant는 서비스 설정으로 읽기 전용 키를 둘 수 있다(`QDRANT__SERVICE__READ_ONLY_API_KEY`). 이 설정 이름과 지원 버전은 적용 전에 Qdrant 문서로 확인한다.
  - 통화 서버(`ai` 컨테이너)에는 **읽기 전용 키만** 준다.
  - 쓰기 키는 색인 스크립트에만 준다.
  - 컬렉션별 권한이 필요하면 JWT 기반 접근 제어를 검토한다.

## 4. 컬렉션 설계 (권장안)

- 컬렉션 `manuals`. 벡터 크기는 임베딩 차원, 거리는 `Cosine`.
- 포인트 하나 = 청크 하나. payload 예:

  ```json
  {"source": "manuals/packing.md", "title": "포장 안내", "version": "2026-10-01",
   "heading": "깨지기 쉬운 물품", "ord": 3, "content": "청크 본문"}
  ```
- 필터로 자주 쓰는 payload(`source`, `version`)에는 payload 인덱스를 만든다.
- 재색인은 새 컬렉션(예: `manuals_v2`)에 넣은 뒤 **별칭(alias) `manuals`를 바꿔 끼운다.** 검색 쪽은 항상 별칭 이름만 쓰므로, 색인 중에도 통화가 끊기지 않는다.
- 색인은 **통화 서버와 별개인 스크립트**(예: `ai/scripts/ingest_manuals.py`)로 한다. 쓰기 키를 쓴다.

## 5. 통화 흐름에 붙이는 방법

### 구조 이해 (먼저 읽기)

- 음성 모델(GPT-Live)이 고객과 말한다. 서버는 오디오를 다루지 않는다.
- **대화 상태(단계) 전환은 서버가 고객 말을 직접 판별해서 한다**(`app/listener.py`, `spec/flow.md`). 고객 답마다 백엔드 도구 호출을 거치면 지연이 생기기 때문이다.
- 백엔드 모델(Responses 위임)은 **값 기록과 주문 작업 도구만** 부른다(`app/tools/`, `spec/tools.md`).
- 상태가 바뀌면 서버가 `session.thinking.append`로 음성 모델에 "다음에 할 일"을 알린다(500토큰 한도).

### 권장: 백엔드 도구 `search_manual`

매뉴얼 답은 자유 문장이라 선택지 판별로는 만들 수 없다. 그래서 백엔드 도구로 검색하고, 백엔드 모델이 결과로 답을 만들어 음성 모델에 돌려주는 방식을 권한다.

1. **도구 파일 하나** `app/tools/search_manual.py`: 기존 도구(`lookup_orders.py` 등)와 같은 모양으로 쓴다.
   - `@tool(이름, 설명, 인수 모델)`로 등록하면 자동으로 잡힌다.
   - 인수 모델은 `Args`를 상속한다(strict, `max_length`).
   - 결과는 `Result({"chunks": [...]})`로, 실패는 `ToolError(...)`로 돌려준다.
   - 결과에는 청크 본문을 짧게 잘라 몇 개만 넣는다(백엔드 응답 지연·토큰).
   - 이 도구는 **사건을 내지 않는다**(`events` 비움). 검색은 대화 단계를 바꾸지 않는다.
2. **`config/live.toml`**: `[[delegation.responses.tools]]`에 `name = "search_manual"`을 추가한다. 이름만 적으면 설명·스키마는 코드에서 채운다.
3. **허용 단계**: 질문은 아무 때나 나올 수 있다. 그래서 `app/flow/stages/_common.py`의 `COMMON_TOOLS`와 `subflows.py`의 각 단계 `tools`에 넣는다. 허용 단계 밖 호출은 디스패처가 거절한다.
4. **검색 모듈** `app/rag.py`: Qdrant 검색과 질문 임베딩을 맡는다.
   - 모양은 `app/backend_api.py`(백엔드 API 클라이언트)를 참고한다. async HTTP 클라이언트에 시간 제한을 두고, 예상 밖 응답은 예외로 처리한다.
   - 질문 임베딩은 `openai` 비동기 클라이언트로 만든다. 이벤트 루프를 막지 않는다(`spec/concurrency.md`).
5. **연결**
   - `app/main.py` lifespan에서 RAG 클라이언트를 만들고 닫는다.
   - `app/services.py`의 `Services`와 통화 객체(`app/call.py`의 `Call`, 도구의 `ctx`)에서 쓸 수 있게 넘긴다. 지금 `ctx.backend`가 백엔드 API를 넘기는 방식과 같다.
   - Qdrant가 죽어도 통화는 계속돼야 한다. 검색 실패는 오류 결과로 돌려주고 상담원 연결을 안내한다.
6. **환경변수**: `ai/compose.yaml`의 `ai` 서비스에 `QDRANT_URL: http://qdrant:6333`과 읽기 전용 키 변수를 추가하고, `.env.example`에 키 이름을 적는다.
7. **지시문**
   - `prompts/voice.md` 위임 규칙에 "서비스·요금·포장 등 매뉴얼 질문은 백엔드에 맡긴다"를 추가한다. 지금은 주문 정보와 접수된 주문 작업만 맡긴다고 되어 있다.
   - `prompts/backend.md`에 "`search_manual` 결과에 있는 내용으로만 답하고, 없으면 모른다고 한 뒤 상담원 연결을 제안한다"를 추가한다.
8. **서버 설정**: `config/server.toml`에 `[rag]`(컬렉션 이름, 임베딩 모델, 결과 개수, 점수 하한, 결과 최대 글자 수, 시간 제한)를 두고 `app/config.py`에 검증 모델을 추가한다. `ServerConfig`는 모르는 키를 거부(`extra="forbid"`)하므로 모델을 꼭 같이 추가한다. 코드에 숫자·문구를 박지 않는다(`spec/server-config.md`).

### 대안: 판별로 질문만 감지

`app/listener.py`의 용건(`INTENTS`)에 `question`을 추가해 "질문했음"만 감지하는 방법도 있다. 그다음 서버가 직접 검색하고 결과를 `thinking.append`로 넘긴다. 백엔드 왕복이 없어 빠르다.

다만 이 방법에는 제약이 있다.
- `thinking.append`는 500토큰 한도라 넣을 수 있는 매뉴얼 내용이 적다.
- 질문 문장을 그대로 얻으려면 받아쓰기를 따로 다뤄야 한다.

먼저 권장안으로 만들고, 실제 통화에서 지연이 문제면 이쪽을 검토한다.

## 6. 지켜야 할 것 (AGENTS.md에서)

- 테스트는 실제 OpenAI·Qdrant를 부르지 않는다.
  - 임베딩은 가짜 클라이언트로 대체한다(`tests/conftest.py`의 `FakeClient` 참고).
  - Qdrant는 가짜 HTTP 전송(`httpx2.MockTransport`)으로 시험한다(`tests/test_backend_api.py` 참고).
- 테스트: `uv run pytest -q`. 도구마다 단위 테스트(정상·인수 오류·허용되지 않은 단계)를 둔다. `tests/test_tools.py`의 레지스트리 테스트가 `live.toml`과 도구 목록이 맞는지 확인한다.
- 통화 서버에는 읽기 전용 키만 준다. 매뉴얼에 개인정보를 넣지 않는다.
- 비밀값은 환경변수로. 이미지·설정 파일에 넣지 않는다.
- 코드 주석·문서·커밋 메시지는 한국어. 커밋·푸시는 요청받을 때만.

## 7. 끝나면 고칠 문서

- `spec/rag.md` 새로 작성(설계: 원본·청크·임베딩·컬렉션·검색·통화 연결). 이 인계 문서의 내용은 그쪽으로 옮기고 이 파일은 지운다.
- `AGENTS.md`의 설계 문서 표에서 RAG 행을 `spec/rag.md`로 바꾸고, "아직 없는 것"에서 RAG를 지운다.
- `spec/tools.md`의 도구 목록, `spec/server-config.md`(`[rag]`).
- `docs/WORKLOG.md`에 날짜별로 바꾼 것·확인한 것·남은 것.
