# AI 통합 인계 요약

백엔드 릴리스 `7c7ec448ef2a-159`와 AI 이미지 `dva-ai-server:7f47bee367a3`를 묶은 통합 인계본 기준입니다. 상세 설명은 [AI 인계 문서](HANDOVER.md)에 있습니다.

## 프로젝트 구조

| 경로 | 역할 |
|---|---|
| `app/main.py`, `pbx_webhook/`, `app/webhooks/` | FastAPI 기동, OpenAI 수신·PBX 종료 웹훅, 백엔드의 FAQ·페르소나 변경 알림 처리 |
| `app/calls/`, `app/tools/`, `app/domain/` | 통화 상태 관리, 도구 실행, 고객 확인과 배송 초안 처리 |
| `app/integrations/`, `backend_client/`, `app/address/` | 백엔드 API 호출, 주소 보정과 카카오 주소 검색 |
| `app/rag/`, `gpu/` | FAQ 동기화·검색과 외부 Qwen 리랭커 |
| `app/persistence/`, `app/observability/` | SQLite 아웃박스와 통화 로그·구간 측정 |
| `config/`, `policy/`, `prompts/` | 서버 설정, 상담 업무 규칙, 통화 후 검토 지시문 |

## 처리 흐름

1. **설치**. 통합 ZIP의 `install.sh`가 사전 빌드 이미지와 초기 데이터를 불러오고, 백엔드·AI·Qdrant를 같은 Compose 프로젝트에서 각각 기동합니다. 초기 상담 페르소나는 **친절형**(v28), 목소리는 `noeul`입니다.
2. **통화 수신**. PBX가 OpenAI로 SIP 통화를 넘기고, OpenAI 수신 웹훅은 호스트 Nginx를 거쳐 AI에 도달합니다. AI가 웹훅 서명을 검증하고 발신번호로 고객을 조회한 뒤 통화를 수락합니다.
3. **배송 접수**. `gpt-live-1`이 고객과 대화하고 `gpt-6-luna`가 도구 호출과 고객의 확인 여부 판정을 맡습니다. AI는 통화 중 배송 초안을 `EDITING`으로 저장하고, 고객 확인과 검증을 마친 항목은 `READY`로 저장합니다. 통화 종료 처리에서 백엔드에 확정을 요청하고 통화 기록과 분석 결과를 전송합니다.
4. **PBX 종료 알림**. PBX는 호스트 Nginx의 `POST /api/webhooks/pbx/call-ended`로 종료 알림을 보냅니다. Nginx는 백엔드에 전달하고 AI의 `/pbx/webhook/call-ended`에도 미러링합니다.
5. **FAQ**. 백엔드가 PostgreSQL에 등록한 초기 FAQ 41건의 변경을 알리면 AI가 원문을 조회하고 임베딩해 빈 Qdrant 볼륨에 색인합니다. 큐 상태 `APPLIED`로 반영을 확인합니다. 질문이 들어오면 키워드·벡터 검색을 합쳐 후보를 찾고, 외부 Qwen 리랭커로 다시 순위를 매깁니다.

## 설정값

통합 ZIP의 `.env.example`과 `ai.env.example`을 합쳐 `~/dva-deploy/shared/.env`에 둡니다. 아래 값은 AI 연동에 필요한 항목입니다.

| 구분 | 값 |
|---|---|
| OpenAI 필수 | `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`. 수신 이벤트는 `live.transport.incoming`, 공개 경로는 `/api/webhooks/openai/call-incoming` |
| PBX 필수 | `PBX_WEBHOOK_TOKEN`. Compose가 AI의 `PBX_WEBHOOK_SECRET`에도 같은 값을 전달 |
| 백엔드·AI 공용 필수 | `AI_BUSINESS_TOKEN`, `AI_INSIGHTS_TOKEN`, `AI_PERSONA_TOKEN`, `AI_FAQ_TOKEN`을 각각 한 번 입력 |
| FAQ 필수 | `QDRANT_API_KEY`, `RAG_RERANKER_URL`(외부 HTTPS), `RAG_RERANKER_API_KEY` |
| Compose 내부 주소 | 백엔드 → `http://ai:8000`, AI → `http://backend:3000` 및 `http://qdrant:6333`. AI 호스트 바인딩은 `127.0.0.1:8000` |
| 모델·로그 기본값 | `BACKEND_MODEL=gpt-6-luna`, `BACKEND_EFFORT=low`, `AI_LOG_LEVEL=INFO` |
| 주소 보정 선택값 | `KAKAO_REST_API_KEY`, `ADDRESS_DATA_DIR`. 주소DB 기본 위치는 `~/dva-deploy/shared/ai-data/address.db` |
| 통합 `server.toml` | 배송 초안 `parcel_draft_intake=true`, FAQ 수신·처리 `receive_enabled=true` 및 `process_enabled=true`. 관리 컬렉션은 `manuals_backend_faq_large` |
| 검색·통화 기본값 | `text-embedding-3-large`(3,072차원), `Qwen/Qwen3-Reranker-0.6B`, 리랭킹 후보 5개. AI 워커 1개, 동시 통화 상한 20건 |
| 로컬 테스트 | 저장소의 `ai/.env.example`을 사용합니다. 메모리 백엔드를 쓰려면 `BACKEND_MOCK=true`를 명시합니다 |
