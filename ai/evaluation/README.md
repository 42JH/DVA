# RAG 평가 자료

- `datasets/faq_retrieval_v1.json`: 사람이 검토한 검색 평가95문항.
- `datasets/faq_v1/cases.json`: 질문·기준 답변·필수 사실·정답 근거·청크 ID를 연결한 고정 사본95문항. manifest로 원문/문항 해시를 확인한다.
- `datasets/decision_v1.json`: 통화 기록의 Decision 발화 208개에 표시한 정답(통화 기록 앞 8자리#전사 번호 → 질문별 정답, 후보 선택은 순번). `scripts/replay_decisions.py`로 기존·새 입력을 비교한다(`docs/architecture/decision-input-plan.md` §8). 구현자가 표시했고 사람 검수 전이다.
- `results/baseline_summary.json`: 기존 텍스트/Live 전체 실험 집계와 원본 파일 해시. 새 통합 코드의 측정 결과가 아니다.
- `results/live_baseline_cases.json`: 실제 기존 Live 전사95개, 질문·기준 답변·공개 근거와 각 점수. 비밀·원시 오디오·전송 이벤트는 제외했다.
- `results/analysis.md`: 결과 해석·설계 결정·남은 검증.
- 새 실행의 대용량/민감 원본은 `data/private/evaluation/runs/<새 버전>/`에 저장한다. 기존 결과를 덮어쓰지 않는다.

개발 데이터로 여러 번 튜닝했기 때문에95문항 점수는 새 고객 질문에 대한 독립 시험 정확도가 아니다. 새 문항·모호한 질문·문서 밖 질문·정책 충돌·장애·실제 전화 전사를 별도로 검증한다.

```bash
uv run python -m scripts.evaluate_retrieval --dry-run
uv run python -m scripts.index_markdown --dry-run
```

실제 평가(외부 API 비용 발생)는 먼저 GPU/DB를 준비한 뒤 새 출력 폴더로 실행한다. 아래 웹 실험은 실제 Live 음성을 합성 입력으로 시험하며 PBX를 호출하지 않는다.

```bash
uv run python -m scripts.run_live_lab
uv run python -m scripts.run_live_rag_eval --help
uv run python -m scripts.run_text_rag --help
```

Ragas는 별도 환경에 `scripts/requirements-ragas.txt`로 설치한다. 전화 서버 SDK를 평가용 버전으로 교체하지 않는다. `scripts.score_text_rag`, `score_factual_correctness`, `calibrate_relevancy`를 사용한다. 질문·기준 답변은 채점에만 쓰고 생성 LLM에 기준 답변을 넣지 않는다. 평가 지표 상세는 `../docs/rag-evaluation-metrics.md`.

웹 실험에는 RAG만 허용해 도구 선택을 강제한 경로가 있고, 실제 전화는 주문 도구와 RAG를 함께 둔 auto 선택이다. 웹95문항 결과를 실제 전화 도구 선택/접수 회귀 검증으로 대신하지 않는다.
