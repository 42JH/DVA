# Docker 빌드·실행과 Qdrant

원본 `S15P31D109/ai`의 `Dockerfile`·`.dockerignore`·`compose.yaml`·`compose.qdrant-dashboard.yaml`·`gpu/`를 기준으로 했다.
**RAG(Qdrant 연결·리랭커 호출·색인 스크립트·리랭커 서버 이미지)는 원본 그대로이며 이 저장소에서 수정하지 않는다**(README "RAG").

## 구성
| 파일 | 내용 |
|---|---|
| `Dockerfile` | python:3.14-slim + uv, `uv sync --frozen --no-dev`, 비루트 사용자(uid 10001), tiktoken 캐시 사전 준비(원본과 같음), 워커 1개. **기본 CMD는 S0 스파이크 서버**(관제 포함) — 새 서버(`app/main.py`)가 생기면 CMD만 바꾼다 |
| `.dockerignore` | 원본 규칙 기준: `.env`, 테스트, 문서, `evaluation/`, `gpu/`, `scripts/*`(bootstrap_faq만 포함), `app/rag/gpu.py`·`text_agent.py` 제외 |
| `compose.yaml` | `qdrant`(v1.13.4, API 키 필수, 내부망 `rag_net`만 — 원본 서비스 정의 그대로) + `ai`(127.0.0.1:`AI_PORT`, `/healthz` 헬스체크) |
| `compose.qdrant-dashboard.yaml` | 원본 그대로의 개발 PC 전용 오버레이: Qdrant를 127.0.0.1:6333으로 연다 |
| `gpu/` | 원본 그대로: 리랭커 서버 이미지(`app/rag/gpu.py`, Qwen3-Reranker). GPU 머신에서 `docker build -f gpu/Dockerfile .` |

## 실행
```bash
# .env에 최소: OPENAI_API_KEY, OPENAI_WEBHOOK_SECRET, SPIKE_BACKEND_MODEL, MONITOR_USER, MONITOR_PASSWORD, QDRANT_API_KEY
docker compose up -d --build
curl http://127.0.0.1:8000/healthz
# 관제: http://127.0.0.1:8000/monitor (MONITOR_USER/MONITOR_PASSWORD)
```

### Qdrant 대시보드·매뉴얼 색인(개발 PC, 원본 스크립트)
```bash
docker compose -f compose.yaml -f compose.qdrant-dashboard.yaml up -d
# http://127.0.0.1:6333/dashboard  (API 키 = QDRANT_API_KEY)
uv run python -m scripts.index_markdown --dry-run         # 해시 검사만
uv run python -m scripts.index_markdown                   # 원본 스크립트가 .env를 직접 읽는다(python-dotenv), QDRANT_URL 기본 127.0.0.1:6333
uv run python -m scripts.bootstrap_faq [--enqueue]        # 관리 FAQ 최초 이전(BACKEND_API_URL 필요)
```
- 컬렉션 설정은 `config/server.toml` `[rag]`·`[faq_sync]`(원본 섹션 그대로).
- 관리 FAQ 처리기(`app/rag/faq_processor.py`)와 웹훅(`app/webhooks/faqs.py`)을 띄우는 조립 코드는 아직 없다(새 서버 S1 범위, `app/tests/test_rag_compat.py`가 웹훅 연결 방식을 보여 줌).

## 확인한 것 (2026-11-03)
- `docker build` 성공, compose 기동 시 `ai` healthy, `/healthz` 200, `/monitor` 무인증 401·인증 200.
- 컨테이너 안에서 원본 RAG 로드(`app.rag.service.RagService`, `app.webhooks.faqs`, `load_server_config`), `http://qdrant:6333` 접속·API 키 인증 성공, 틀린 키 거부, 호스트에 6333 미노출(오버레이 없이), 이미지에서 `app/rag/gpu.py` 제외.
- `scripts.index_markdown --dry-run` 성공(32개 FAQ, 3072차원).
- `gpu/` 이미지는 빌드하지 않았다(CUDA 베이스 이미지, GPU 머신용).

## 주의
- **Qdrant 버전 불일치**: 클라이언트 `qdrant-client==1.19.1`(원본 pyproject)과 서버 이미지 `v1.13.4`(원본 compose)가 맞지 않아 경고가 난다. 원본도 같은 조합이다. RAG 담당 영역이라 바꾸지 않았다 — RAG 담당자와 확인 필요.
- 컨테이너 안 Qdrant 연결은 HTTP라 "Api key is used with an insecure connection" 경고가 난다(내부망 전용).
- 원본에서 가져오지 않은 것: `Jenkinsfile`, `deploy/`(GCP·배포 스크립트·리랭커 systemd 서비스·`compose.deploy.yaml`), 라이브 랩 전용 스크립트 3개.
