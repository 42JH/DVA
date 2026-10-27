# 전화 상담 RAG 계약

2026-10-27 통합 기준. 운영 배포 순서는 `docs/rag-handoff.md`, 점수 정의는 `docs/rag-evaluation-metrics.md`.

```text
고객 전화 → PBX → Live
                 ↓ client 위임
AI 서버 → SDK Responses 백엔드(도구 선택 한 번)
                 ↓ search_manual
질문 large 임베딩 + Kiwi BM25 → Qdrant → 가중 RRF Top5
                 ↓ HTTPS /rerank
GPU Qwen3-Reranker-0.6B → 원문 Top3
                 ↓ thinking 조각 + ACK + commentary 완료 신호
Live가 근거를 비교해서 발화 → 전사·도구 시간은 기존 인증된 관제에 기록
```

- 고객·주문·주소는 기존 백엔드 API, 매뉴얼은 Qdrant. 두 저장소를 섞지 않는다.
- 현재 지원 원본은 공개 `manuals/delivery_faq.md`. 제목 분할 + 재귀 분할 800자/겹침50자, FAQ당 한 청크를 검증한다. 소개/출처 두 청크는 검색 후보에서 제외한다. PDF·HTML·질문만 임베딩 실험은 운영 대상에서 제외한다.
- 통합 질문+답변을 `text-embedding-3-large`, 3072차원 Cosine으로 저장한다. 검색 설명은 원문과 별개로 해시 검증해 검색 입력에만 추가하고 답변 근거에는 붙이지 않는다.
- Kiwi 업무 용어 사전 + BM25, dense는 전체 FAQ를 조회한다. BM25 0.4/dense 0.6, 순위 기반 RRF c=60. 각 점수를 그대로 더하지 않는다. 융합 Top5만 Qwen에 보낸다.
- Qwen 입력은 기존 A 형식(고객 질문과 원문 Q+A), revision `e61197ed45024b0ed8a2d74b80b4d909f1255473`, FP16, 최대1024토큰. 입력을 조용히 자르지 않는다. yes/no logit 차이로 재정렬하고 동점은 원래 RRF 순서를 유지한다. 추가 query expansion/multiquery LLM 호출은 없다.
- `app/rag/`는 운영 구현, `scripts/`는 색인/점검/평가 실행 도구. 운영 모듈이 scripts를 import하지 않는다. `app/rag/gpu.py`는 외부 GPU에서만 실행하며 전화 이미지에는 torch를 설치하지 않는다.
- 서비스는 원본과 DB 일치 여부, 모델/차원, 후보 ID·본문을 확인한다. 운영 중 자료가 바뀌면 실패로 안내하고 새 버전으로 명시적으로 재색인한다. 시작 시 새 컬렉션 생성·삭제·재임베딩하지 않는다.
- `search_manual`은 읽기 전용이며 LangGraph 사건을 생성하지 않는다. 상담원 전환·주문 취소·접수는 기존 확인 절차로만 한다.
- 결과는 검증한 고유 Top3의 제목·출처·본문. 점수는 정답 확률이 아니다. 한 append는 여유를 두어350토큰으로 나누며 자료 문자를 버리지 않는다. ACK는 모델 맥락 전달 확인이며 발화 내용의 정확성이나 고객 청취를 보증하지 않는다.
- 새 client 위임이 오면 옛 읽기/모델 작업은 취소하고 늦은 결과는 무시한다. 이미 시작한 쓰기는 새 위임 때문에 취소·재실행하지 않는다. 통화 종료나 HTTP timeout의 실행 결과가 불명확하면 성공으로 안내하지 않는다.
- GPU·임베딩·DB·ACK 실패는 짧은 실패 안내로 바꾸고 현재 접수를 이어간다. 실패를 성공 점수/본문으로 대체하거나 CPU/다른 모델로 몰래 바꾸지 않는다.
- 운영 숫자는 server.toml, 비밀은 환경변수, 음성/백엔드 지침은 Markdown으로 관리한다.

공식 이벤트 계약: [OpenAI Live delegation](https://developers.openai.com/api/docs/guides/live-delegation).
