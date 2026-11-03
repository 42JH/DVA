# 리빌드 서버 실통화 시험 (S5~)

**반드시 가짜 BE(`BACKEND_MOCK=true`)로 한다.** 리빌드 전 기존 서버가 실제 BE에 연결돼 운영 중이라, 리빌드 서버가 실제 BE에 고객 확인·통화 등록·주문·취소를 보내면 데이터가 섞인다(사용자 지시 2026-11-03). `.env`와 `compose.yaml` 모두 기본이 `BACKEND_MOCK=true`다. 시작 로그 `BE: 메모리 가짜 BE(BACKEND_MOCK=true)`를 확인한다.

## 실행
```bash
# 컨테이너(배포와 같은 이미지, Qdrant 포함). 이미지 CMD = app.main
docker compose -f compose.yaml -f compose.qdrant-dashboard.yaml up -d --build
# 또는 로컬 프로세스(같은 포트라 컨테이너는 먼저 끈다: docker compose stop ai)
uv run --env-file .env python -m uvicorn app.main:app --port 8000 --workers 1
```
- 컨테이너 통화 로그는 호스트 `logs/calls/`, 아웃박스는 볼륨 `ai_state`(/app/state).
- 필요한 값(`.env`): `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `SPIKE_BACKEND_MODEL`(또는 `BACKEND_MODEL`), `BACKEND_MOCK=true`, 관제용 `MONITOR_USER`·`MONITOR_PASSWORD`. 선택: `KAKAO_REST_API_KEY`(지번·우편번호), `data/address.db`(없으면 주소 보정 없이 들은 그대로).
- 웹훅 경로는 스파이크와 같다: `https://<host>/api/webhooks/openai/call-incoming`. 터널·OpenAI 웹훅 등록은 그대로 둔다.
- 관제: `http://127.0.0.1:8000/monitor`(단계·전사·Decision·도구 사건).
- 통화가 끝나면 `logs/calls/<trace_id>.json`(단계·Decision 판정·도구 결과 코드·전사 — 개인정보, 커밋 안 함).

## 매뉴얼 검색(RAG)
- 원본 RagService(`app/rag/`, 수정 금지)를 그대로 붙였다. 서버 기동 때 Qdrant·리랭커를 확인하지 않는다 — 꺼져 있어도 서버는 뜨고 그 검색만 `KB_UNAVAILABLE`("지금 확인이 어렵다")이 된다.
- Qdrant(로컬 포트 127.0.0.1:6333만): `docker compose -f compose.yaml -f compose.qdrant-dashboard.yaml up -d qdrant`. `.env`의 `QDRANT_URL`이 비어 있으면 이 주소를 쓴다.
- 컬렉션이 비어 있으면 한 번 색인(원본 스크립트, FAQ 32개): `PYTHONPATH=. QDRANT_URL=http://127.0.0.1:6333 uv run --env-file .env python scripts/index_markdown.py`
- 리랭커는 GCP GPU VM(`dvr-reranker-l4`, 켤 때마다 30분 뒤 자동 중지). 시험 전에 켜고 `/health` 200 확인: `gcloud.cmd compute instances start dvr-reranker-l4 --project=dvr-rerank --zone=asia-northeast3-a`(원본 ai/deploy/gcp/README.md). 꺼져 있으면 검색이 연결 시간 초과(약 5초) 후 unavailable.
- FAQ 변경 알림(`/internal/faqs/refresh`)·관리 색인은 원본 설정대로 꺼져 있다(`[faq_sync] receive_enabled·process_enabled = false`).

## 페르소나
- 통화 진입마다 BE 대기(PENDING)를 확인하고 APPLIED 회신 → ACTIVE 확인 후 그 통화에 고정(진행 중 통화는 시작 버전 유지). BE 알림 `/internal/persona/refresh`(202)·옵션 `/internal/persona/options`.
- 가짜 BE는 토큰 없이 켜지고 ACTIVE가 비어 있어 서버 기본 프롬프트로 받는다. 실제 BE는 `AI_PERSONA_TOKEN`이 있어야 켜진다.
- 적용 결과가 불명확하면(회신 응답 유실) 확인될 때까지 새 통화를 503으로 거절한다(계약).

## 가짜 BE의 한계
- 프로세스 메모리라 서버를 껐다 켜면 고객·주문이 사라진다. 처음 거는 번호는 "처음 이용하는 고객"이다.
- 조회·취소를 시험하려면 가짜 BE에 주문을 넣어야 한다(지금은 실행 중 넣는 화면이 없다 — 필요하면 요청).
- S6부터 통화 결과·고객 등록·분석·이벤트·미답변이 **가짜 BE로** 간다. 관제 "통화 결과"·"고객.등록"에서 본다. 아웃박스는 `state/outbox.sqlite3`(서버를 다시 켜면 끝나지 않은 전송을 같은 키로 다시 보낸다 — 가짜 BE는 비어 있으므로 새로 저장된다).
- 주소DB(`data/address.db`, 지금 있음)가 없으면 지번·우편번호가 비어 결과가 INCOMPLETE(ADDRESS_GEO_MISSING)가 된다. 카카오 키가 있으면 들은 주소로 지번·우편번호를 찾는다.

## 대본(S5)
1. "택배 보내려고요" → 보내는 분 성함·주소·상세 → 받는 분 성함·연락처·주소·상세 → 물품·가액(수거 일시는 묻지 않는다 — "결제 후 1시간 안에 방문")
2. AI가 되읽으면 "네, 맞아요" → "담아 두었어요"류 안내(N2)
3. "더 없어요" → 마무리 인사 → 서버가 끊음
4. 변형: 되읽기 중 "아니요, 연락처가 …" 정정 / 번호를 틀리게 불러 보기 / 끝난 뒤 관제의 통화 결과 상태(가짜 BE: 카드 = notPaid)
