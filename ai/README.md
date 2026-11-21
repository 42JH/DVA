# AI 전화 접수 서버

전화로 들어온 택배 접수·조회·취소·문의를 음성으로 응대하는 서버입니다. PBX가 전화를 OpenAI SIP로 넘기면 이 서버가 통화를 받아 고객과 대화하고, 백엔드(BE) API로 업무를 처리합니다.

- Python 3.14 / FastAPI, 의존성 관리는 `uv`
- 음성 대화: OpenAI 실시간 음성 세션(SIP 수신)
- 업무 판단·도구 호출: Responses API 위임(`BACKEND_MODEL`)
- FAQ 검색(RAG): Qdrant + 외부 리랭커 서버
- 주문·고객·주소록: 백엔드 API (`backend_client/`)

AI 파트를 인수하시거나 처음 배포하신다면 아래 두 문서를 순서대로 읽어 주세요.

1. [인계 요약본](HANDOFF-SUMMARY.md) ([PDF](HANDOFF-SUMMARY.pdf))에서 프로젝트 구조, 처리 흐름, 통합 배포 설정값을 살펴보실 수 있습니다.
2. [상세 인계 문서](HANDOVER.md) ([PDF](HANDOVER.pdf))에서 통합 설치, 외부 연동, 초기 데이터와 동작 확인 절차를 살펴보실 수 있습니다.

## 빠른 실행

```bash
cp .env.example .env          # 복사한 파일의 변수 설명을 참고해 값을 입력해 주세요.
docker compose up -d --build  # Qdrant + AI 서버
curl http://127.0.0.1:8000/healthz
```

- 실행 전에 `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `PBX_WEBHOOK_SECRET`, `BACKEND_API_URL`, `QDRANT_API_KEY`를 설정해 주세요.
- 백엔드 없이 실행하려면 `BACKEND_MOCK=true`를 설정해 주세요. 모의 백엔드는 데이터를 메모리에 저장하므로 재시작하면 데이터가 사라집니다.
- 통화 상태는 프로세스 메모리에 저장하므로 **워커는 1개**로 실행해 주세요.
- 컨테이너 없이 실행하려면 `uv sync` 후 `uv run --env-file .env python -m uvicorn app.main:app --port 8000 --workers 1`을 실행해 주세요.

자세한 절차는 `docs/ops/docker.md`(로컬·Compose), `docs/ops/deploy.md`(Jenkins 배포), `docs/ops/live-test.md`(실통화 시험)를 참고해 주세요.

## 폴더 구성

```
app/
  main.py            서버 조립(공유 클라이언트, 라우터, 백그라운드 작업)
  calls/             통화 생명주기, 통화 중 흐름, 결과 전송, 페르소나 적용, 통화 후 검토
  domain/            업무 상태와 규칙(접수 항목, 확인 관문, 운임, 수거 시각)
  tools/             모델이 부르는 도구와 실행기
  policy/            정책 파일 로더와 지시문 렌더링
  integrations/      백엔드 게이트웨이, 카카오 주소 검색, 주소 보정 서비스
  address/           행안부 주소DB 기반 주소 보정
  rag/               FAQ 검색, FAQ 동기화, 리랭커 서버
  webhooks/          백엔드 → AI 알림(FAQ 변경, 페르소나)
  persistence/       결과 전송 아웃박스(SQLite)
  observability/     통화 trace와 구간 측정
backend_client/      백엔드 API 클라이언트와 메모리 모의 백엔드
pbx_webhook/         OpenAI 수신 웹훅, PBX 통화 종료 웹훅
policy/              업무 규칙, 기본 페르소나, 정책 정의(workflow.toml)
config/              서버 설정(server.toml), RAG 검색 설명
prompts/             통화 후 검토 프롬프트
manuals/             FAQ 원문
persona_check/       페르소나 시험 창구(별도 컨테이너)
call_analysis/       통화 불만 판정 기준 구현(별도 서비스, 백엔드 이식본의 기준)
gpu/                 리랭커 서버 이미지
deploy/              배포 스크립트와 compose 오버레이, GPU 서버 구축 스크립트
scripts/             운영 점검 스크립트
docs/, spec/         설계·계약·운영 문서
```

## 외부에서 들어오는 요청

| 경로 | 보내는 쪽 | 인증 |
|---|---|---|
| `POST /api/webhooks/openai/call-incoming` | OpenAI(전화 수신) | 웹훅 서명(`OPENAI_WEBHOOK_SECRET`) |
| `POST /pbx/webhook/call-ended` | PBX(통화 종료) | `Authorization: Bearer <PBX_WEBHOOK_SECRET>` |
| `GET /internal/persona/options`, `POST /internal/persona/refresh` | 백엔드 | `Authorization: Bearer <AI_PERSONA_TOKEN>` |
| `POST /internal/faqs/refresh` | 백엔드 | `AI_FAQ_TOKEN` |
| `GET /healthz`, `GET /health` | 점검용 | 없음 |

연동 계약은 `docs/contracts/pbx-webhooks.md`와 `docs/be-contract/`에서 확인하실 수 있습니다.

## 통화 한 통의 흐름

1. OpenAI가 수신 웹훅을 보냅니다. 서버는 서명을 검증하고 발신번호로 고객을 조회한 뒤 통화를 수락합니다.
2. 음성 모델이 고객과 대화합니다. 지시문은 페르소나(백엔드에서 받음, 없으면 `policy/persona_default.md`)와 업무 규칙(`policy/business_rules.md`)을 이어 붙여 만듭니다.
3. 고객이 값을 말하면 위임 모델이 도구를 호출하고, 서버가 인수를 검증한 뒤 실행합니다.
4. 접수·취소처럼 되돌릴 수 없는 일은 서버가 확인 관문을 거친 뒤에만 실행합니다.
5. 통화가 끝나면 결과·통화 기록·분석을 백엔드로 보냅니다. 전송 전에 아웃박스에 저장해 재시작에도 같은 키로 다시 보냅니다.

전체 설계는 `docs/architecture/overview.md`를 참고해 주세요.

## 모델이 부르는 도구

| 도구 | 하는 일 |
|---|---|
| `record_fields` | 고객이 말한 택배 값을 기록하거나 정정합니다. 전화번호·수거 시각을 검증하고 주소를 보정합니다 |
| `find_destination` | 주소록, 이전 도착지, 기업 배송지에서 받는 곳을 찾습니다 |
| `lookup_orders` | 지금 전화한 번호의 주문과 이번 통화에서 담은 택배를 찾습니다 |
| `search_manual` | FAQ·이용 정책을 검색합니다 |
| `get_state` | 기록된 항목과 빠진 항목을 조회합니다 |

서버는 확인 관문을 통과한 뒤 접수 확정과 취소를 직접 실행합니다. 도구 계약은 `docs/contracts/tool-contracts.md`에서 확인하실 수 있습니다.

## 설정 파일

| 파일 | 내용 |
|---|---|
| `.env` | 비밀값과 연결 주소를 설정합니다. 항목은 `.env.example`을 참고해 주세요 |
| `config/server.toml` | RAG, FAQ 동기화, 백엔드 호출, 운임, 통화, 통화 후 검토 설정 |
| `policy/workflow.toml` | 접수 단계, 항목, 확인 질문, 입력 한도 |
| `policy/business_rules.md`, `policy/backend_rules.md` | 음성 모델과 위임 모델에 주는 업무 규칙 |
| `policy/persona_default.md` | 백엔드에서 페르소나를 가져오지 못했을 때 사용하는 기본 말투 |

Compose는 `config/`와 `prompts/`를 읽기 전용 볼륨으로 연결합니다. 이 두 폴더는 이미지 재빌드 없이 수정할 수 있습니다. `policy/`는 이미지에 포함됩니다.

## 주소 보정

- `data/address.db`(행안부 주소DB를 가공한 SQLite)가 있으면 들은 주소를 실제 주소로 보정합니다. 없으면 들은 주소를 그대로 사용합니다.
- 주소DB를 만들려면 `uv run python -X utf8 -m app.address.gazetteer <주소DB 텍스트 폴더> data/address.db`를 실행해 주세요.
- `KAKAO_REST_API_KEY`가 있으면 지번·법정동·우편번호를 카카오 주소 검색으로 채웁니다.

## FAQ 검색(RAG)

- 벡터 DB는 Compose의 `qdrant` 서비스이며 내부망에서만 접근할 수 있습니다. 개발 PC에서 대시보드를 보시려면 `compose.qdrant-dashboard.yaml`을 함께 사용해 주세요.
- 리랭커는 별도의 GPU 서버(`gpu/`)에서 실행합니다. 구축 절차는 `deploy/gcp/README.md`를 참고해 주세요. 주소와 키는 `RAG_RERANKER_URL`과 `RAG_RERANKER_API_KEY`로 설정합니다.
- 백엔드의 FAQ 관리 화면에서 FAQ를 바꾸면 백엔드가 `/internal/faqs/refresh`로 알리고, 서버가 원문을 다시 받아 색인합니다. `config/server.toml`의 `[faq_sync]`에서 동기화를 켤 수 있습니다.
- Qdrant나 리랭커에 장애가 발생해도 서버는 기동할 수 있으며, FAQ 검색 시에는 자료를 확인할 수 없다고 안내합니다.
- 계약과 인계 내용은 `spec/rag.md`, `spec/faq-sync.md`, `docs/rag-handoff.md`를 참고해 주세요.

## 함께 배포되는 보조 서비스

| 서비스 | 용도 | 실행 |
|---|---|---|
| `persona_check/` | 관리자가 페르소나를 적용하기 전에 시나리오 통화로 시험합니다. 백엔드가 호출합니다 | AI 서버 이미지를 기반으로 별도 컨테이너에서 실행합니다. `persona_check/README.md`를 참고해 주세요 |
| `call_analysis/` | 종료된 통화의 불만과 응대 오류를 판정합니다. 운영 구현은 백엔드에 있으며, 이 폴더는 판정의 기준 구현을 담고 있습니다 | `call_analysis/README.md` |

## 운영 점검 스크립트

| 스크립트 | 용도 |
|---|---|
| `scripts/bootstrap_faq.py` | 백엔드의 FAQ 전체를 처음 한 번 색인 대기열에 넣습니다 |
| `scripts/index_markdown.py` | `manuals/`의 원문을 새 Qdrant 컬렉션에 색인합니다 |
| `scripts/search_manual.py` | 운영과 같은 검색을 질문 하나로 점검합니다 |
| `scripts/check_remote_reranker.py` | 리랭커 서버 호출을 점검합니다 |
| `scripts/inspect_faq_json.py` | 저장해 둔 FAQ 원문을 오프라인으로 살펴봅니다 |
| `scripts/validate_faq_crud.py` | FAQ 변경 알림부터 색인까지를 검증용 컬렉션으로 점검합니다 |

## 테스트

현재 AI 파트에 남아 있는 자동 테스트는 백엔드 스크립트에서 사용하는 기준 테스트(`call_analysis/tests/test_call_analysis.py`)입니다. 추가 테스트를 작성하실 때는 `pyproject.toml`의 개발 의존성에 있는 `pytest`와 `httpx`, `backend_client/mock.py`의 메모리 모의 백엔드를 사용하실 수 있습니다.

Jenkins는 이미지 빌드 뒤 배포 스크립트 문법과 `import app.main`만 확인합니다.

## 개인정보

- 통화 기록(`logs/calls/<trace_id>.json`)에는 전사와 업무 값이 그대로 들어갑니다. `.gitignore` 대상이므로 커밋하지 않도록 주의해 주세요.
- 아웃박스(`state/`)와 FAQ 대기열(`rag_state/`)도 런타임 데이터입니다.
