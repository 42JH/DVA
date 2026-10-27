# RAG 전화 통합 인계 (2026-10-27)

기준 develop-ai는 `2b111f6`. 통합 브랜치는 `feature/S15P31D109-122-rag-call-integration`이다. 아직 develop-ai에 병합하거나 운영 배포하지 않았다. 이전 작업 브랜치와 stash를 보존했다.

## 팀원 코드에서 유지한 것

- LangGraph 단계 엔진·Studio, 고객 답 판별과 지연 기록, PBX 종료 웹훅 Bearer 검증, 서명 검증·중복 수신 방지, 발신번호 기준 고객/주문 API, 고객 확인 후 접수·수정·취소·상담원 연결을 유지했다.
- develop-ai 자동 배포 Jenkins/deploy 스크립트는 바꾸지 않았다. 이 브랜치를 develop-ai에 병합하면 기존 CI/CD가 동작할 수 있으므로 운영 준비 확인 후 병합한다.
- LLM은 OpenAI SDK, 문서 분할·임베딩·검색만 LangChain이다. 상태 분기를 RAG/LLM으로 옮기지 않았다.

## 변경한 연결 방식

이전 `responses` 위임은 도구 결과를 백엔드에 반환하고 다시 실행해야 한다. 사용자 요구처럼 RAG 결과를 바로 Live가 판단하도록 기본을 `client` 위임으로 바꿨다. `[backend]` 설정은 서버 전용으로 사용하고 Live 세션 본문에는 보내지 않는다. `app/client_backend.py`가 백엔드를 한 번 호출해 도구를 선택하고 `app/dispatcher.py`가 실제 도구를 실행한다. 이후 응답 생성용 백엔드 호출 없이 결과를 Live에 직접 전달한다.

`config/live.toml`의 모델·도구, `config/server.toml`의 timeout, `prompts/voice.md`/`backend.md`를 같이 검토한다. RAG 원문 전달은 서버가 만들며 모델의 자유 생성 답변을 정책 근거로 사용하지 않는다. 기존 responses 이벤트 처리도 복귀용으로 남겼지만 그 모드는 직접 전달 방식이 아니다.

## 먼저 준비할 것

1. Qdrant에 검토한 원문과 같은 large 컬렉션이 있어야 한다. 개발 PC의 DB가 배포 서버에 자동 복사되는 것은 아니다.
2. GPU 서버에서 `/rerank`를 실행한다. RunPod/GCP 모두 같은 HTTP 계약이다. 주소와 키는 사용자/운영자가 설정한다. `.env`는 읽거나 수정하지 않았다.
3. AI 실행 환경에 `QDRANT_URL`, `QDRANT_API_KEY`, `RAG_RERANKER_URL`, `RAG_RERANKER_API_KEY`를 지정한다. URL은 `/rerank` 전의 루트, 외부 연결은 HTTPS이다. compose의 Qdrant 주소는 내부 `http://qdrant:6333`이다.
4. 정책표 기준 실제 요금 계산은 백엔드와 연결한다. 아래 금액 정책/미완료 계약을 확인한다.

```bash
cd ai
uv sync --frozen
uv run pytest -q
uv run python -m scripts.index_markdown --dry-run
# 실제 등록은 API 비용이 생긴다. 기존 이름이면 거절한다.
uv run python -m scripts.index_markdown --collection manuals_dev_openai_large
```

색인 CLI만 쓰기 키를 사용한다. 통화 중 검색 경로는 읽기만 한다. Qdrant1.13.4/client1.19.1 호환성 경고는 기존 상태를 보존했으며 이번 작업에서 데이터 삭제/버전 변경으로 없애지 않았다. 운영 버전 정렬과 읽기/쓰기 키 분리는 스냅숏·공식 지원 범위를 확인한 별도 작업이다.

## 외부 GPU 실행

전화 서버의 uv 환경과 **별도 Python3.12 GPU 환경**을 쓴다. 아래는 Linux GPU 서버의 ai/ 기준이다. 드라이버/CUDA와 PyTorch 조합은 서버 이미지에서 확인한다. 모델은 시작 때 한 번 로드하고 예열하며 요청마다 다시 받지 않는다.

```bash
uv venv --python 3.12 .venv-gpu
uv pip install --python .venv-gpu/bin/python -r gpu/requirements.txt
# 운영자가 RAG_RERANKER_API_KEY를 환경변수로 설정한다. 값을 저장소에 쓰지 않는다.
.venv-gpu/bin/hf download Qwen/Qwen3-Reranker-0.6B --revision e61197ed45024b0ed8a2d74b80b4d909f1255473
.venv-gpu/bin/uvicorn app.rag.gpu:app --host 0.0.0.0 --port 8001 --workers 1
```

GPU 포트는 플랫폼 HTTPS 프록시/인증 뒤에 둔다. 모델 캐시는 영구 디스크에 두고 `HF_HOME`을 쓸 경우 다운로드 때와 실행 때 똑같이 지정한다. 전화 Docker 이미지는 GPU 실행 파일을 제외하므로 GPU 서버에는 저장소 소스와 gpu/requirements.txt를 전달한다.

요청/응답 계약:

```json
POST /rerank
Authorization: Bearer <운영자가 설정한 키>
{"question":"착불로 보낼 수 있나요?","documents":[{"chunk_id":"id1","content":"질문과 답변 원문"}]}

{"model":"Qwen/Qwen3-Reranker-0.6B","revision":"e61197ed45024b0ed8a2d74b80b4d909f1255473","results":[{"chunk_id":"id1","score":2.4}]}
```

1~5개, 고유 ID, 원문 입력, 유한 점수만 허용한다. 전화 서버는 반환된 본문을 사용하지 않고 자신의 원문을 점수로 정렬한다. `/health`는 모델/버전 상태 확인이며 실제 요청 속도/정확성을 보장하지 않는다. 모델의 최대 토큰을 넘으면422, 인증 실패401이다.

Google 신규가입 $300인 경우 무료 체험 상태에는 GPU/할당량 증설 제한이 있다. 유료 전환 후 남은 크레딧은 원래90일 만료까지 유지되며 초과 비용은 청구된다. 별도 GPU quota와 지역 재고를 확인한다. 서울 G2(L4)를 후보로 검토하되 실제 준비 시간·왕복·동시 요청 지연을 측정한 뒤 정한다. Spot/요청마다 시작하는 구성은 중단·첫 요청 대기를 전화 요구사항과 비교해야 한다. 근거: [무료 체험](https://docs.cloud.google.com/free/docs/free-cloud-features), [GPU quota](https://docs.cloud.google.com/compute/docs/gpus/about-gpus), [지역](https://docs.cloud.google.com/compute/docs/regions-zones/gpu-regions-zones).

## 고정 요금 제거와 백엔드 계약

3,500원 고정값·확정 안내·수정 후 고정 요금 반환을 제거했다. 가격을 아직 확인하지 못했다면0원이나 다른 임시 금액으로 대체하지 않는다. AI는 금액 미확정 접수 요청에서 fare를 생략한다. **백엔드가 이 요청을 받아 실제 규격으로 계산할 수 있는지는 아직 실서버에서 확인하지 않았다.**

사용자 결정: 실제 접수는 우선 유인 지점 기준이며 백엔드가 다음 표로 계산한다.

| 프로젝트 구분 | 정책 규격 | 유인 기준 금액 |
|---|---|---:|
| 서류 | 극소형 | 3,850원 |
| 소박스 | 소형 | 4,950원 |
| 중박스 | 중형 | 6,050원 |
| 대박스 | 대형 | 7,150원 |

현재 AI 임시 주문은 이름/주소/물품 내용 등9개 항목이고 별도 규격 필드가 없다. `item="옷"`만으로 소형/대형을 추정해서 계산할 수 없다. 백엔드 담당과 **규격 전달 필드, 실제 계산/접수 응답 금액 계약**을 맞춘 뒤 고객에게 확정 금액을 안내해야 한다. 이번 변경에서 임의의 가격 API를 만들어 연결하지 않았다. FAQ의 무인/유인 정책 검색은 유지하되 실제 접수 기준과 구분한다.

## 파일과 보존 범위

- 운영: app/rag(분할·스키마·알고리즘·원격 리랭커·검색 서비스), app/client_backend.py, tools/search_manual.py, 세션/관제/프롬프트 통합.
- 공유: manuals/, evaluation/datasets/, evaluation/results/ 집계 및 분석, 평가 CLI/가짜 테스트, 팀 work.md.
- 개발 웹 실험: app/live_lab과 scripts/run_live_lab.py. 운영 이미지에서는 제외한다. 기본 검색은 같은 외부 리랭커, 과거 재현만 별도 local CUDA 환경을 선택한다.
- 제외: PDF 연결/HTML 변환, 질문만/질문·답변 분리/C형식/BGE 모델 비교 CLI, 로컬 절대경로, 모델 가중치, API 키, 임시 ZIP, 원시 음성, 대용량 원시 실행 기록. 원본은 기존 브랜치/stash/data/private에 보존했고 DB를 지우지 않았다.

## 병합 전 확인

가짜 테스트는 외부 API 없이 통합 경로·중복·오래된 결과·timeout·상태 보존을 검증한다. 실제 PBX 호출에서 전사 시점, 도구 선택, Top3 발화, 끼어들기, 상담원 동의, 접수·취소·변경, GPU 장애를 별도 확인한다. 이 통합 브랜치의 새 코드로95문항 유료 재평가는 실행하지 않았다. 과거 점수는 `evaluation/results/` 기준선으로 구분한다. 외부 GPU 연결과 요금 계약이 준비되기 전 운영 완료/검증 완료라고 쓰지 않는다.
