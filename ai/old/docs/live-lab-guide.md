# Live-1 웹 음성 실험 사용법

## 바뀐 흐름

브라우저에서 질문 → Live-1이 위임 → 백엔드 LLM이 검색 도구 한 번 호출 → RAG Top3 → Live-1이 직접 판단·발화.

기존 텍스트 평가의 두 번째 백엔드 답변 호출을 제거한 경로다. 기존 실제 전화 서버를 바꾸는 대신 독립 웹 실험 서버로 확인한다. 기술 계약과 측정 한계의 기준 문서는 [spec/live-lab.md](../spec/live-lab.md)다.

## 시작

ai 폴더에서 실행한다. Qdrant와 외부 GPU `/rerank`를 먼저 준비한다. 기본 search_backend는 remote이며 전화와 같은 RAG 서비스를 사용한다. 필요한 외부 GPU 환경은 docs/rag-handoff.md를 따른다. 과거 로컬 재현만 search_backend=local로 바꾸고 별도 CUDA 환경의 QWEN_PYTHON을 지정한다.

```powershell
uv run --locked python -m scripts.run_live_lab
```

필요한 환경변수는 OPENAI_API_KEY, QDRANT_URL, QDRANT_API_KEY, RAG_RERANKER_URL, RAG_RERANKER_API_KEY, MONITOR_USER, MONITOR_PASSWORD다. 실행 시 기존 .env를 자동 로드하며 내용을 표시하지 않는다. 프로그램이 .env를 만들거나 수정하지 않는다. 인증값이 없으면 서버를 열지 않는다.

브라우저에서 [http://127.0.0.1:8020/live-lab](http://127.0.0.1:8020/live-lab)을 열고 MONITOR_USER/MONITOR_PASSWORD로 로그인한다. 화면의 **마이크 연결 시작**을 누르고 브라우저의 마이크 권한을 허용한다. 소리가 들리지 않으면 오디오 컨트롤의 재생 버튼과 출력 장치를 확인한다. 로컬 마이크 또는 HTTPS가 필요하다.

마이크 음성과 필요한 FAQ 근거는 OpenAI로 전송된다. 시작 버튼을 누르기 전에는 Live 세션을 생성하지 않는다. 실제 주문·결제·상담원 연결은 실행하지 않는다. 연결 종료는 화면의 **대화 종료**를 사용한다. 최대 연결 시간은 설정상600초이며 서버를 종료하려면 실행 터미널에서 Ctrl+C를 사용한다.

## 확인할 질문

- 무인 지점에서 소형 택배를 보내면 얼마인가요?
- 저녁 늦게 전화해도 접수할 수 있나요?
- 이미 발송된 택배도 취소할 수 있나요?
- 받는 사람이 배송비를 내게 할 수 있나요?

대화 전사에서 고객 말과 실제 Live 발화를 보고, 오른쪽 Top3에서 원문에 근거하는지 확인한다. 근거 전달 알림 전에 나온 맞장구를 정답 안내로 세지 않는다. 질문을 정정하거나 AI가 말하는 중 끼어들었을 때 현재 질문에 맞는 근거가 쓰이는지도 확인한다.

## 화면에서 보는 시간

상단에는 백엔드 검색 선택, 질문 임베딩, 검색+리랭킹, 근거 전달 후 첫 음성 프레임 수신 시간을 표시한다. 타임라인에는 맥락 조각 전달과 최초 전사·오디오 및 브라우저 출력 감지가 남는다. 서버 수신·브라우저 재생·Live 타임라인은 다른 시계이므로 섞어 계산하지 않는다. 표시된 첫 음성이 정답 안내인지 여부는 전사와 함께 사람이 판단한다.

두 번째 LLM 호출을 없앤 효과와 새 근거 조각 전달 대기를 합쳐 비교해야 한다. 실제 측정 전에는 이전 평균4.55초보다 빨라졌다고 주장하지 않는다. 기존95문항의 점수는 텍스트 모델 답변의 점수이며 Live 발화 점수로 재사용하지 않는다.

## 기록과 오류

**기록 내보내기**를 누르면 JSON을 내려받는다. 고객/AI 전사, 검색어, Top3, 위임별 backend/search/context 전달 시간, 최초 출력 관찰과 브라우저 감지 이벤트가 포함된다. API 키·인증값·SDP·원시 오디오 바이트는 포함하지 않는다. 자유 대화에는 기준 답변이 없으므로 Ragas 자동 채점은 하지 않는다.

Live 세션 생성 오류는 모델 접근 권한·요금·API 상태 등을 확인해야 하며, 화면에는 비밀값을 제외한 오류 종류만 나온다. 근거 전달 오류가 나면 일부 자료를 성공으로 간주하지 않는다. 인증 쿠키가 없는 새 브라우저는 다른 세션의 전사·기록을 읽을 수 없다. 새로고침하면 새 연결이 필요하며 종료하지 않은 세션은 최대 수명까지 살아 있을 수 있으므로 먼저 대화를 종료한다.

UI 초기 화면만 검사하려면 서버를 실행한 상태에서 다음 명령을 사용한다. 이 명령은 마이크와 Live 세션을 시작하지 않는다.

```powershell
uv run --with playwright python -m scripts.check_live_lab_ui
```

스크린샷은 Git 제외 data/private/live-lab에 저장한다. 이 검사는 실제 음성 품질·모델 접근 권한을 확인하는 검사가 아니다.

## 기존95문항을 Live 발화로 채점

현재 화면으로 자유롭게 대화한 기록에는 문항 ID가 없으므로, 다음 실행기를 사용해 기존 평가 질문을 합성 음성으로 재생한다. 문항마다 새 Live 세션을 사용하며 실제 RAG를 검색한다. 유료 API를 호출하고 공개 FAQ 내용이 OpenAI로 전송된다. 개발 중 검토한95문항을 다시 사용하는 평가다.

처음에는 한 문항으로 확인한다. 웹 서버와는 별도 실행이므로 화면 로그인은 필요 없다. 같은 config/live-lab.toml과 RAG 구현을 사용한다.

```powershell
uv run --locked python -m scripts.run_live_rag_eval --id faq_03_02 --output data/private/evaluation/runs/integration_live_smoke_v1/generation.json
```

전체 실행은 다음과 같다. 기존 결과와 충돌하면 기존 폴더를 지우지 말고 새로운 실행 이름을 사용한다. 동시3건은 처리량을 위한 설정이며 한 사람의 단독 통화 지연 측정에는 --concurrency 1을 사용한다. 성공 문항은 재실행 시 건너뛰고 실패하면 다음 새 문항 실행을 중단한다.

```powershell
uv run --locked python -m scripts.run_live_rag_eval --concurrency 3 --output data/private/evaluation/runs/integration_live_full_v1/generation.json
```

생성이 완료되면 별도 Ragas 환경으로 채점한다. 이 실행도 유료 평가 모델 API를 사용한다. 질문·기준 답변은 평가 단계에서만 연결하며 생성 모델에게 정답을 주지 않는다.

```powershell
data/private/ragas-env/Scripts/python.exe -m scripts.score_text_rag --generation data/private/evaluation/runs/integration_live_full_v1/generation.json
uv run --locked python -m scripts.summarize_live_rag --generation data/private/evaluation/runs/integration_live_full_v1/generation.json
```

generation.json에는 실제 전사와 검색 후보, evaluation.json/review.md에는 검색 지표와 네 Ragas 점수, analysis.json/md에는 시간과 검토 대상이 남는다. 첫 음성은 맞장구일 수 있고 합성 음성·WebSocket 수신 시간은 실제 마이크·브라우저 스피커 지연과 다르다. 기존 텍스트 응답 완료8.8초와 첫 음성 수신을 직접 비교하지 않는다. 응답 완료는 API 신호가 아닌 침묵으로 추정한다.
