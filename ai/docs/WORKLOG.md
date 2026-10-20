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
  - `delegation.responses.model`(지금 `gpt-5.4-mini`)이 GPT-Live 위임에서 되는지.
  - strict 스키마의 `maxLength`가 위임 백엔드에서 받아들여지는지.
- RAG(pgvector)
  - 주문 DB와 데이터베이스·계정을 나눌 것.
  - 지금 `ai-db`에는 주문 계정 하나뿐이다.
- 진행 문구·지시문은 실제 통화를 들어 보며 다듬어야 한다(`prompts/`).
- 등록 고객의 받는 순서: 지금은 "지난번 받는 분 질문"만 앞에 둔다. 순서를 바꾸려면 `app/flow/stages/collecting.py`.
- 아직 없는 기능(AGENTS.md "아직 없는 것")
  - 추가 주문에서 앞 주문과 같은 보내는 분 쓰기.
  - 알림톡, 실제 요금 API, 결제, outbound.
