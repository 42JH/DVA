# RAG 평가 지표와 데이터 관리

2026-10-27 기준. 대상은 기존 검토 완료 dev95문항이다. 질문 수를 맞추려고 미검토 문항을 추가하지 않는다. 원격 GPU·PBX·음성 입력 대신 로컬 텍스트 질문과 실제 검색 도구 호출을 사용한다.

## 평가 흐름

질문 → LLM의 search_manual 호출 → BM25 및 large 벡터 검색 → RRF Top5 → 로컬 Qwen 리랭킹 → Top3 → PromptTemplate으로 근거 표시 → LLM 최종 답변 → 별도 채점.

답변 LLM에 주는 것은 질문과 실제 검색된 근거다. 기준 답변, 정답 근거, 필수 사실은 검색·재정렬·답변 생성에 넣지 않고 완료 후 채점에만 사용한다. 검색 오류, 도구 미호출, 무응답도 결과로 기록한다. 문항 실패를 조용히 제외하고 전체 성공률로 보고하지 않는다.

## 검색 지표: 책을 제대로 찾았는가

| 지표 | 평가 대상 | 계산·해석 | 예시 |
| --- | --- | --- | --- |
| BM25 Recall@5 | 키워드 검색 | 정답 근거 중 BM25 Top5에 포함된 비율 | 필요한 책 두 권 중 한 권을 찾으면 0.5 |
| Dense Recall@5 | 의미 기반 벡터 검색 | 같은 정답 기준으로 벡터 Top5의 포함 비율 | 표현이 달라도 필요한 책을 찾는지 |
| RRF Recall@5 | 두 검색의 결합 | 결합 후 리랭커에 넘길 후보 5개가 정답을 포함하는 비율 | 이 단계에서 빠진 책은 리랭커가 복구할 수 없음 |
| Reranked Recall@3 | Qwen 재정렬 후 | 최종 전달하는 Top3가 정답 근거를 포함하는 비율 | 후보에 있었는데 Top3에서 빠졌는지 |
| Hit@K | 각 검색 단계 | 정답 중 하나라도 TopK에 있으면 1, 없으면 0 | 정답 두 권 중 하나만 찾아도 Hit는 1 |
| MRR | 여러 질문의 첫 정답 순위 | 질문별 첫 정답 순위의 역수 평균. 1위=1, 2위=0.5 | 첫 정답이 얼마나 위에 배치되는지 |

Recall@K = TopK와 정답 ID 집합의 교집합 크기 / 정답 ID 개수. 현재처럼 정답 FAQ가 하나인 질문에서는 Hit@K와 Recall@K가 같지만, 여러 근거를 요구하는 질문에서는 다르다. 정답 ID는 faq_v1의 expected_chunk_ids를 사용한다. FAQ별 한 청크라는 현재 기준선이 바뀌면 정답 연결도 새 데이터셋 버전에서 다시 검토한다.

BM25·Dense는 단독 Top5, RRF는 결합 Top5, Qwen은 그 동일 후보의 Top3를 평가한다. 공정한 비교를 위해 Qwen 전후 모두 Top3 지표도 추가로 비교할 수 있다. 단계별 후보 수가 다른 수치만으로 리랭커 자체의 개선을 단정하지 않는다. 검색 한 번의 처리에는 이 단계들이 모두 포함되며, 도구를 여러 번 호출하면 호출별 지표와 횟수를 보존한다.

## Ragas 지표: 찾은 자료와 최종 답변이 좋은가

이번에는 네 지표를 직접 제공하는 Ragas를 사용한다. TruLens의 RAG Triad는 Context Relevance·Groundedness·Answer Relevance 중심이므로 유사한 관점을 제공하지만 점수와 계산 방식이 같지는 않다. 두 도구의 점수를 같은 지표처럼 섞지 않는다.

| 지표 | 질문 | 입력 | 주의할 점 |
| --- | --- | --- | --- |
| Faithfulness | 답변의 주장들이 검색 근거로 뒷받침되는가? | 고객 질문, 실제 답변, 전달한 문맥 | 엉뚱한 문서에 충실한 답도 높게 나올 수 있으므로 정답성 점수는 아님 |
| Answer Relevancy | 답변이 고객 질문의 의도에 맞는가? | 고객 질문, 실제 답변 | Ragas가 답변에서 역질문을 만들고 원 질문과 임베딩 유사도를 계산. 사실 정확성과 별개 |
| Context Precision | 정답 안내에 쓸모 있는 근거가 위에 놓였는가? | 고객 질문, 기준 답변, 순서 있는 실제 문맥 | 단순 '정답 문서 수/3'이 아니라 관련 문맥 순위를 고려한 평균 정밀도 |
| Context Recall | 기준 답변에 필요한 정보를 문맥이 담고 있는가? | 고객 질문, 기준 답변, 실제 문맥 | 기준 답변의 주장 단위 포함 비율. ID 기반 Recall@K와 다름 |

비유하면 Faithfulness는 '책에 없는 이야기를 지어냈는가', Answer Relevancy는 '물어본 문제에 답했는가', Context Precision은 '유용한 책을 앞에 놓았는가', Context Recall은 '답에 필요한 설명을 모두 가져왔는가'다.

Ragas 문맥에는 실제 도구 결과로 LLM에 전달한 Top3 원문과 제목을 사용한다. 실제 답변은 LLM 최종 응답이다. 여러 검색 호출이 있으면 전달 순서대로 실제 문맥을 모아 사용하고 호출별 Top3는 별도로 보존한다. 도구 미호출로 문맥이 없으면 문맥이 필요한 지표는 미측정으로 표시하고 사유를 기록한다.

Answer Relevancy 채점을 위한 역질문 생성은 오프라인 채점 과정이다. 고객 요청 경로의 MultiQuery나 query expansion을 활성화하는 것이 아니다. 네 점수를 평균 내어 최종 정답률이라고 부르지 않는다. 최종 정답성은 기준 답변·필수 사실과의 별도 검토가 필요하다.

## 보조 지표와 해석

- 도구 호출률/성공률, 무응답·오류·시간 초과 건수를 함께 보고한다.
- 첫 LLM 판단, 질문 임베딩, DB 검색, BM25, RRF, Qwen, 후속 LLM과 전체 완료 시간을 기록한다. 모델 준비 시간은 별도다. 스트리밍 첫 음성 시간이나 실제 통화 지연으로 부르지 않는다.
- 평균과 p95, 실행 동시성을 남긴다. 로컬 GPU와 원격 GPU 지연은 같은 값으로 가정하지 않는다.
- 실행 모델·프롬프트·문서·데이터셋 해시, SDK 버전과 채점 모델을 남긴다. 개발용 95문항을 여러 번 튜닝했으므로 독립 test 성능은 아니다.
- 채점 실패는 0점으로 위장하지 않는다. null과 오류 사유, 지표별 유효 표본 수를 표시한다. LLM 채점은 자동 보조 판정이므로 낮은 점수와 정책·금액·예외 관련 문항을 사람이 검토한다.
- '어떻게 판단했는가'는 검색어·후보·근거·최종 답변·채점 설명으로 추적한다. 모델의 숨겨진 내부 추론을 정답처럼 추출하지 않는다.

## 데이터셋과 결과 폴더

실제 기업 문서·질문·답변·근거는 Git 제외 data/private 아래에 보관한다. 아래 경로는 ai 기준이다. 기존 faq_eval_v1.json과 과거 results 파일은 이동·삭제하지 않는다.

```text
data/private/evaluation/
├── datasets/
│   └── faq_v1/
│       ├── cases.json       # 질문·기준 답변·필수 사실·정답 근거
│       ├── manifest.json    # 버전·원본/자료 해시·검토 범위
│       └── README.md
├── runs/
│   └── 실행이름/
│       ├── generation.json # 실제 도구 호출·단계별 후보·실제 답변·시간
│       ├── evaluation.json # 검색 지표·Ragas 지표·오류와 상세 판정
│       └── review.md       # 사람이 질문별 결과를 확인하는 보고서
└── results/                # 과거 실험 결과 보존
```

cases.json의 각 문항: id, question, reference_answer, required_facts, expected_faq_titles, expected_chunk_ids, reference_evidence(chunk_id/source_id/title/content), reference_contexts, category, split, review_status, answerable.

generation.json에는 정답을 넣지 않는다. 실행 결과의 tool_calls마다 BM25 전체 순위, 벡터 전체 순위, RRF Top5, Qwen 재정렬 Top5, 전달 Top3를 기록한다. evaluation.json에서만 문항 ID와 질문을 대조해 정답을 연결한다. 정답 근거는 기존 사람이 검토한 FAQ 제목에 원문을 연결해 만든 사본이며 새 독립 검토를 의미하지 않는다.

## 재현 순서

1. uv run python -m scripts.prepare_text_eval_dataset: 기존95문항과 원문으로 datasets/faq_v1을 만든다. 동일 버전을 다른 내용으로 덮어쓰지 않는다.
2. run_text_rag: 실제 질문별 검색·답변을 runs/실행이름/generation.json에 기록한다. --question으로 직접 질문하거나 --id/--limit으로 소량 확인한다. 같은 출력 경로는 같은 입력·모델·프롬프트·자료일 때만 재개한다.
3. score_text_rag: 생성 결과를 읽어 별도 평가 환경에서 Ragas와 ID 지표를 채점한다. 답변을 새로 생성하거나 DB를 수정하지 않는다.

Ragas는 scripts/requirements-ragas.txt의 평가 전용 환경을 사용한다. 앱의 OpenAI 3.35.1을 내리지 않는다. 평가 환경 OpenAI 3.3.0, Ragas0.4.3, langchain-community0.3.31은 설치 호환 확인 결과다. 현재 버전의 community0.4.2는 Ragas가 import하는 vertexai 모듈이 없어 별도 환경에서만 버전을 고정했다.

PowerShell 예시(ai 디렉터리). 아래 생성·채점 명령은 OpenAI로 기업 FAQ·질문·답변·기준 답변을 보내는 실제 API 실행이므로 명시적 전송 승인 후 실행한다. --offline은 uv의 의존성 다운로드만 막으며 Python 코드의 API 호출을 막지 않는다.

```powershell
# 원문과 검토 완료 질문의 고정 사본만 생성: API 없음
uv run --locked python -m scripts.prepare_text_eval_dataset

# 로컬 CUDA 환경은 기존 computer_vision 환경. 다른 PC에서는 실행 파일 경로를 바꾼다.
# 먼저 한 문항 확인: 실제 API 있음
uv run --locked python -m scripts.run_text_rag --id faq_03_02 --output data/private/evaluation/runs/text_rag_smoke_v1/generation.json --concurrency 1

# 네 지표 채점: 실제 API 있음. 앱 환경과 분리된 평가 환경에서 실행
data/private/ragas-env/Scripts/python.exe -m scripts.score_text_rag --generation data/private/evaluation/runs/text_rag_smoke_v1/generation.json

# 95문항 실행은 --id를 빼고 별도 runs/text_rag_full_v1 폴더를 사용한다.
```

초기 실행은 자동 승인 검토가 기업 자료 외부 전송의 명시적 승인 부족으로 거부했다. 이후 2026-10-27 사용자가 FAQ는 공개 자료라고 확인하며 OpenAI 전송을 명시적으로 승인했다. 이 승인 후 text_rag_smoke_v1과 text_rag_full_v1을 실제 실행했다. 최종 채점 상태와 결과는 각 실행 폴더의 evaluation.json을 확인한다. 준비·초기 거부 상태를 실제 실행 결과와 혼동하지 않는다.

## 실제 응답 시간의 해석 (2026-10-27)

별도 단건(text_rag_smoke_v1)은 전체8.844초 중 첫 LLM2.744초, 질문 임베딩3.765초, BM25/DB/RRF약0.170초, Qwen0.360초, 후속 LLM1.801초였다. 시작 준비12.477초는 요청 시간과 별도다. 임베딩 시간은 벡터 계산만이 아니라 LangChain 임베딩 호출 전체의 벽시계 시간이다. 로컬 전처리·연결·네트워크·서비스 대기·계산·결과 수신을 포함할 수 있다. 내부 단계와 재시도 횟수를 계측하지 않아3.76초의 원인을 특정할 수는 없다.

이후 같은 파이프라인의 전체95개 실행(text_rag_full_v1, 동시성3)은 질문 임베딩 평균0.1972초, 중앙값0.1846초, p95 0.2814초, 최소0.1435초, 최대0.4182초였고3초 이상은0개다. 첫 단건의3.76초를 매 질문의 고정 비용으로 해석하지 않는다. 이95건에서 재현되지 않은 지연이며 실제 운영 부하의 상한을 보장하는 수치도 아니다.

전체 최종 텍스트 완료 시간은 평균4.552초/p95 14.100초였다. 평균 첫 LLM1.941초+후속 LLM2.033초로 두 API 왕복이 대부분을 차지했다. API 지연에는 네트워크/서비스 대기/생성이 섞여 있어 서버 내부 연산만 느리다고 단정하지 않는다. 전체 실행 및 단건 상세는 runs/text_rag_full_v1/analysis.md에 함께 기록한다.

실행 후 아래 명령으로 추가 API 호출 없이 분석 보고서를 만들 수 있다.

```powershell
uv run --locked python -m scripts.summarize_text_rag --run-dir data/private/evaluation/runs/text_rag_full_v1 --smoke-dir data/private/evaluation/runs/text_rag_smoke_v1
```

analysis.json/md는 구간별 평균·중앙값·p95·최솟값·최댓값, 검색어 변경, Top3 ID 미적중과 Ragas 현황을 정리한다. 채점 중에 만든 분석은 중간값이므로 완료 후 다시 생성한다. LLM이 원 질문과 다른 검색어를 만든 사례가 있어 과거 원 질문 고정 검색 성능과 동일 조건으로 비교하지 않는다. 첫 토큰·첫 음성 지연은 측정하지 않았다.

## 첫 전체 실행 결과

text_rag_full_v1의 생성95개와 네 지표 각각95개(총380개 채점)가 모두 완료됐다. 답변 모델은 gpt-6-luna/low, 채점은 gpt-4.1, Relevancy 임베딩은 text-embedding-3-small, 검색은 large/Qwen 기준선이다. 생성 실패·검색 오류·채점 실패는0건이다.

| 평가 | 결과 |
| --- | --- |
| BM25 Recall@5 | 93/95 |
| Dense Recall@5 | 95/95 |
| RRF Recall@5 | 94/95 |
| Qwen Recall@3 | 93/95 |
| Qwen Hit@1 / MRR | 91/95 / 0.97105 |
| Faithfulness 평균 | 0.96123 |
| Answer Relevancy 평균 | 0.59342 |
| Context Precision 평균 | 0.98070 |
| Context Recall 평균 | 0.97895 |

이 자동 점수는 최종 정답률이 아니다. 검색어가 원 질문과 달라진 호출35건이 있어 원 질문 고정 과거 실험과 동일 조건이 아니다. faq_12_02는 정답FAQ가 RRF3위에서 Qwen4위로 밀렸고, faq_20_02는 RRF Top5에서 빠져 착불 불가를 안내하지 못했다. 전자는 다른 포장 근거로 관련 답변을 생성했으므로 ID 미적중만으로 최종답 전체 오답이라고 단정하지 않는다.

판정 한계도 보존했다. faq_10_03의 고객 질문에 있던100cm/5kg을 검색 문맥에 없다고 감점하거나, faq_07_03의 운영 지침에 따른 상담원 연결 의사 확인을 근거 없는 주장으로 보는 사례가 있다. 자동 점수를 임의로 올리지 않고 analysis.md에 사람 검토 메모를 별도로 적었다. 생성 품질·독립 test·실통화 적합성에 대한 최종 합격 판정은 아직 하지 않았다.

## Live-1 직접 발화 평가

2026-10-27부터 백엔드가 최종 답변을 만들지 않고 RAG 근거를 Live-1에 직접 전달하는 경로도 별도로 평가한다. 기존95문항과 정답은 유지하지만 `live_rag_*` 실행 폴더를 사용하며 기존 `text_rag_*` 결과에 덮어쓰지 않는다. 실행법은 [Live 실험 사용법](live-lab-guide.md)의 고정 문항 채점을 따른다.

- 검색: 실제 Live가 위임한 검색어로 BM25/dense/RRF Recall@5·MRR, 리랭킹 Recall@3·Hit@1을 계산한다. 검색 위임 여부/횟수도 함께 기록한다.
- 생성: 실제 Live 출력 전사 전체와 전달된 Top3로 Faithfulness·Answer Relevancy·Context Precision·Context Recall을 계산한다. 기준 답변은 생성 모델에 전달하지 않는다. 이 네 점수의 평균이 최종 정답률은 아니다.
- 시간: 합성 질문 PCM 송신 종료→첫 음성 패킷 수신, 첫 전사, 마지막 출력 및 침묵 후 관찰 종료를 따로 측정한다. backend/임베딩/DB/RRF/Qwen/맥락 조각 ACK 시간도 기록한다. `total_seconds`는 null로 둔다.

첫 음성에는 맞장구가 포함될 수 있다. 근거 전달 직후의 패킷도 이전 발화의 잔여 패킷일 수 있으므로 자동으로 정답 안내 시점으로 표시하지 않는다. WebSocket 실험은 실제 브라우저 재생·전화 지연이 아니며, 전사 오류나 음성 자연스러움은 Ragas만으로 평가되지 않는다. 합성 음성의 정확한 끝·완료 이벤트도 별도 보장되지 않으므로 관찰 기준과 표본 수를 함께 해석한다.

### Live 전체 실행 결과(2026-10-27)

live_rag_full_v1은 실제 발화95/95와 네 Ragas 지표 각각95/95(380개 점수)가 완료됐다. 최종 시도 기준 생성/검색/채점 실패0건이며 입력 합성 음성 오류로 재시도한 이전1건은 이력으로 보존했다. 검색은 BM25/dense Recall@5 각각94/95, RRF Recall@5 95/95, Qwen Recall@3 95/95, Hit@1 92/95, MRR0.982456이다.

| Ragas 평균 | 이전 텍스트 | 이번 Live 전사 |
| --- | --- | --- |
| Faithfulness | 0.96123 | 0.85788 |
| Answer Relevancy | 0.59342 | 0.48253 |
| Context Precision | 0.98070 | 0.98947 |
| Context Recall | 0.97895 | 0.98947 |

검색 성공과 최종 발화 품질을 구분해야 한다. faq_12_02는 정답3위를 활용해 포장 안내를 했지만 faq_07_03은 접수완료/수령완료 조건을 넓혀 표현했다. faq_05_01은 맞는 주소 자동 저장 안내 뒤에 자료에 없는 원치 않는 저장·상담원 권고를 더했다. 반면 faq_14_03은 핵심 정책이 맞아도 맞장구와 합리적 권고를 문서에 없는 주장으로 판정해 Faithfulness0.3333이었다. 원 점수를 수정하지 않고 human_review.md에 실제 조건 오류와 지표 한계를 나눠 기록했다.

첫 음성 패킷 평균1.306초/p95 2.048초, 근거 알림 후 첫 패킷까지 입력 끝에서 평균5.788초, 마지막 출력까지18.859초였다. 근거 전달 ACK만 평균1.671초가 추가되어 백엔드 두 번째 호출 제거만으로 지연 개선을 확정할 수 없다. 시간의 범위가 다른 이전 텍스트 완료4.552초와 직접 비교하지 않는다. 이번91건의 검색어 문자열이 원 질문과 달랐으며 음성 전사·표현 정리도 포함하므로 모델 하나만 바꾼 통제 실험이 아니다.

실행 폴더의 comparison.md, analysis.json/md, review.md, human_review.md를 함께 검토한다. 채점 중 Windows 파일 교체 PermissionError는 임시 저장본의 계약/완료 점수 일치를 확인해 복구하고 제한적인 잠금 재시도로 보완했다. 원본/복구본을 보존하고 완료 점수는 재계산하지 않았다. 코드 검증262개 통과.

## Relevancy 지표 자체의 대조 평가

`scripts/calibrate_relevancy.py`는 고정 faq_v1 기준 답변95개를 실제 답변 자리에 넣어 채점한다. 추가로 동일 질문에 다른 FAQ의 기준 답변95개를 연결해 대조군을 만든다. 서로 겹치지 않는 근거 ID의 FAQ를 목록의 절반 떨어진 위치에서 고르는 고정 규칙을 사용하며 점수를 보고 대조 답변을 바꾸지 않는다. 대조 답변은 synthetic_unreviewed로 표시하며 사람의 관련성 라벨로 취급하지 않는다.

기존 Live와 동일한 Ragas0.4.3/gpt-4.1/temperature0/strictness3/text-embedding-3-small로 AnswerRelevancy만 측정한다. 질문·기준 답변·선택한 대조 출처·역생성 질문·noncommittal 판정·점수·실패/대기 수를 보존한다. 계약 해시가 다르면 재개를 거절하고 완료 점수는 재호출하지 않는다. 기존 Live 점수는 읽어 비교할 뿐 변경하지 않는다. 실제 검색·Live 발화·임베딩 색인도 재실행하지 않는다.

결과는 data/private/evaluation/runs/relevancy_calibration_v1/calibration.json, review.md, summary.md에 저장한다. 두 그룹의 평균/중앙값/범위, 같은 질문에서 기준 답변 점수가 더 높은 횟수, 탐색적 AUC와0.3~0.8 임계값별 통과 수를 기록한다. AUC와 임계값 표는 자동 합성 대조군에 대한 진단이며 배포 합격률이 아니다. 95문항은32FAQ의 변형으로 독립 표본이 아니고, 임계값을 정한 데이터에서 그 임계값을 검증했다고 주장하지 않는다.

```powershell
data/private/ragas-env/Scripts/python.exe -m scripts.calibrate_relevancy
```

기준 답변도 낮은 점수를 받는다면0.8 같은 임의 합격선으로 서비스 품질을 판정하지 않는다. 두 그룹의 분포가 잘 나뉘는지, 낮은 기준 답변/높은 대조 답변이 실제로 관련성 문제가 있는지 사람이 먼저 검토한다. 이 점검은 필수 사실 충족·정책 모순·근거 없는 추가 안내를 보는 정확성 평가를 대신하지 않는다.

### 대조 평가 완료 결과(2026-10-27)

190/190 채점 완료, 실패/누락0건이다. 기준 답변95개 평균0.521229/중앙값0.548437, 다른 FAQ 대조군95개 평균0.210736/중앙값0.210502다. 기존 Live 평균은0.482527이며 같은 문항의 기준 답변 평균과 차이는0.038702다. 이 차이를 정답률 차이나 통계적으로 유의한 품질 차이로 취급하지 않는다.

기준 답변이 같은 질문의 대조 답변보다 높았던 것은84/95, 역전11/95였다. 탐색적 AUC0.879557은 자동 대조군에서 분리 경향이 있음을 보여 주지만 사람 라벨 기준 서비스 성능이 아니다. 0.8을 통과선으로 두면 기준 답변8/95만 통과하며87개를 잘못 탈락시킨다. 0.5에서도 기준 답변56/95 통과, 대조 답변2/95 통과다. 현 결과로 최종 임계값을 정하지 않는다.

기준 답변8개는 역질문3회 모두 noncommittal=1이어서0점으로 내려갔다. 예를 들어 fee_001의 VAT포함5,500원·지점별 차이 안내가 포함된 기준 답변도 해당한다. 어떤 특정 문구가 원인인지 부분 삭제 실험은 하지 않았다. faq_03_02는 기준 답변이 정확해도 일반적인 접수 시간 질문으로 역생성돼0.289045였다. 한국어 문항인데 영어 역질문이 하나 이상 생성된 기준 답변도9개였다. 이 기록을 이유로 원 점수를 바꾸거나 맞장구/조건을 삭제하지 않았다.

따라서 관련성은 보조 진단으로 유지하고 필수 사실/정책 모순/근거 없는 추가 안내를 보는 별도 정확성 평가가 필요하다. 대조군은 미검토이고32FAQ의 개발95문항을 재사용했으므로 사람 검토·별도 검증 없이 배포 합격선을 만들지 않는다. 결과 폴더의 interpretation.md, summary.md, review.md, calibration.json에 해석과 원자료를 보존했다. 전체 가짜 테스트264개 통과.

## Factual Correctness 추가 평가

사용자 선택에 따라 기존 검색/충실도/문맥 지표는 유지하고 최종 답변의 기준 답변 일치를 보는 `FactualCorrectness`를 추가한다. Relevancy 과거 점수는 참고용으로 보존한다. `scripts/score_factual_correctness.py`는 이미 생성된 Live95개의 answer와 고정 reference_answer만 공식 지표에 전달한다. 질문·필수 사실·검색 근거를 기준 답변에 추가하거나 맞장구를 삭제하지 않는다. 실제 검색/발화는 다시 실행하지 않는다.

Ragas0.4.3의 공식 F1 mode, beta1.0, atomicity=low/coverage=low 기본값과 gpt-4.1/temperature0을 사용한다. 모델이 실제 답변의 사실을 기준 답변과 대조한 판정과, 기준 답변의 사실을 실제 답변과 대조한 판정을 방향별로 보존한다. 계산은 공식 라이브러리에 맡기며 기준 답변 미지원 주장을 곧 거짓/환각이라고 이름 붙이지 않는다. 올바른 부가 설명이 검색 근거에는 있지만 기준 답변에는 없어서 감점될 수 있다.

원본 evaluation.json의 해시를 계약에 기록하고 evaluation_with_factual.json에 기존 지표/답변/근거/시간을 복사한 뒤 새 지표만 추가한다. factual_review.md에는 문항별 사실 분해·지원/누락 판정·실제 전달 근거를, factual_summary.md에는 기존 지표와 추가 F1 평균/표본/분포/검토 대상을 기록한다. 성공 점수는 재실행 시 재사용하고 입력·설정이 달라지면 재개를 거부한다. 추가 채점 시간은 서비스 응답 시간과 별개다.

```powershell
data/private/ragas-env/Scripts/python.exe -m scripts.score_factual_correctness
```

점수 구간은 검토를 위한 분포이며 고정 합격선을 설정하지 않는다. 검색·충실도·정확성·시간을 하나의 평균 점수로 묶지 않는다.

### 사실 정확성 추가 채점 결과(2026-10-27)

기존 Live95건 모두 채점 완료, 실패/누락0건이다. FactualCorrectness F1 평균0.7213684211, 중앙값0.67, 최소0/최대1이다. 1점27건, 0.8이상1미만11건, 0.5이상0.8미만46건, 0초과0.5미만10건, 0점1건이다. 평균은 문항 정답률이 아니고 구간은 검토 편의를 위한 것이다. 기존 네 점수·검색·시간과 실제 발화 원문은 변경하지 않았다.

faq_07_03은 접수완료/수령완료 범위를 넓힌 주장 등으로0점이지만 반대 방향 판정에서는 기준 답변의 수령완료 안내가 실제 발화에 있음을 인정했다. fee_001은 금액5,500원은 맞지만 VAT포함/지점별 차이 누락으로0.5였다. faq_12_02는 핵심 포장 안내가 맞고 실제 근거에도 있는 구매/지점 차이 안내가 짧은 기준 답변에 없어서0.33이었다. 낮은 F1을 자동 환각/오답으로 해석하지 않고 실제 근거와 정책 중요도를 함께 본다.

새 통합 결과는 live_rag_full_v1/evaluation_with_factual.json, 질문별 판정은 factual_review.md, 전체표는 factual_summary.md, 사람 검토를 위한 해석은 factual_interpretation.md다. 원래 evaluation.json과 관련성 대조 검증은 그대로 보존한다. 전체 가짜 테스트266개 통과.

## 공식 참고

- [Ragas Faithfulness](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/)
- [Ragas Factual Correctness](https://docs.ragas.io/en/latest/concepts/metrics/available_metrics/factual_correctness/)
- [Ragas Answer/Response Relevancy](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/answer_relevance/)
- [Ragas Context Precision](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_precision/)
- [Ragas Context Recall](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/context_recall/)
- [TruLens RAG Triad](https://www.trulens.org/getting_started/core_concepts/rag_triad/)
> 2026-10-27 통합 위치: 공유 데이터는 `evaluation/datasets/faq_v1/`, 기존 집계/해석은 `evaluation/results/`이다. 아래 과거 실행 경로와266개 테스트 수는 당시 기록이며, 새 통합 브랜치의 실제 전화 검증을 의미하지 않는다. 운영 연결은 `docs/rag-handoff.md`를 참조한다.
