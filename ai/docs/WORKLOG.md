# 작업 기록

## 2026-10-31 Jenkins(Linux) 테스트 간헐 실패 수정

- 증상: Windows에서는 전부 통과, Jenkins와 같은 Linux 컨테이너에서는 `test_sideband.py` 3개가 실행마다 0~3개 실패(AssertionError).
- 실제 버그(`test_17`): 판별 결과를 적용하는(await) 사이에 붙은 다음 말까지 `heard_text = ""`로 지워, "네" 직후 "아 잠깐만요"가 사라지고 확정 지연이 멈춘 채 남았다. `listener._consume`으로 판별한 말만 지운다. 재현 테스트 `test_words_heard_while_answer_is_applied_are_not_lost` 추가(수정 전 실패 확인).
- 테스트 경쟁 상태(운임 안내·RAG 시간 초과): 단계·확정 지연은 진행 상태를 보내기 전에 바뀌므로, 단계가 아니라 문구 도착을 기다리게 했다.
- 확인: 로컬 578개 통과, Linux 컨테이너 전체 통과 + sideband 8회 반복 모두 통과.

## 2026-10-31 LangGraph 재구성 브랜치에 develop-ai(FAQ 관리 a0b4f37) 병합 충돌 해결

- 충돌 4곳(`backend_api.py` docstring, `mock_backend.py` `faqs` 필드, `spec/backend-api.md` 인증 문단, WORKLOG)은 양쪽 내용을 합쳤다.
- 자동 병합된 `config.py`에서 `ServerConfig._commit_after_pause`가 새로 들어온 `FaqSyncConfig` 안으로 붙어 설정 로드가 깨졌다. `ServerConfig`로 되돌렸다. 전체 577개 테스트 통과.

## 2026-10-31 최신 develop-ai 통합·커밋/병합 준비

- 사용자가 Jira를 반영한 커밋과 develop-ai 병합을 요청했다. 현재AI변경을 stash a3845b6으로 보존하고 작업브랜치를 최신origin/develop-ai e6ecf6b로 전진시킨뒤 적용했다. WORKLOG 충돌1건은 양쪽 기록을 모두 보존했다. 기존 stash/tmp/private는 유지했다.
- 최신 팀원 설정/판별/상담원 개선과 함께 전체523개 테스트 통과(32.00초). langchain-community 기존경고1건. 기본 수신/처리 비활성 유지.
- Docker 이미지에서 bootstrap CLI가 빠져 있던 것을 수정했다. 초기자료/체크리스트/공유문서의 미구현 표기를 현재 코드 준비 상태로 정리했다. 운영/평가변경은 Jira123/124 커밋으로 구분한다.
- 로컬 Docker 엔진 미준비로 대기한 빌드는 중단하고 서버에서 별도 faq-merge-check 태그로 이미지 빌드 성공(운영 컨테이너 미변경). 네트워크 없는 컨테이너에서FAQ라우트/비활성설정/비root 상태경로 쓰기/초기등록CLI/GPU·실험앱제외를 확인했다. 기능커밋7cfa077(Jira123)을 생성했다. 평가변경은 별도Jira124 커밋이다.

## 2026-10-31 실제 전체 검증 환경 확정

- 사용자가 현재 운영 환경에서 백엔드 팀원과 준비한다고 확정했다. 검증FAQ만조작하고 AI수신/토큰준비후알림을활성화하는 역할/팀전달문을 체크리스트에 추가했다.
- origin/develop-ai를조회했고 최신e6ecf6b는그대로다. 작업기준c90cc00 이후8파일차이가있으며 고객답판별/끼어들기 개선을 보존할 필요가 있다. 병합/커밋/푸시/운영변경은 하지 않았다.

## 2026-10-31 실제 BE→AI 전체 FAQ 연동 사전 확인

- 운영 AI의 OpenAPI에 FAQ 수신경로가 없고 배포 server.toml에도 faq_sync가 없음을 확인했다. AI/BE 프로세스의FAQ토큰은 모두미설정, BE대상은ai:8000이었다. 실제토큰값/.env는 읽지 않았다.
- 관리자 쓰기 전에 수신코드배포/양쪽토큰/검증환경 준비가 필요하므로 실제 FAQ 추가·수정·삭제는 시작하지 않았다. 체크리스트와 팀전달문 docs/faq-end-to-end-checklist.md를 작성하고 환경 정보를 요청했다.
- 이번 작업은 읽기 전용 사전 점검이며 배포/비밀설정/FAQ/DB/커밋·푸시 변경은 없다. 전체연동검증 통과라고 표시하지 않는다.

## 2026-10-31 FAQ CRUD 실제 검색 반영 통합 검증

- 사용자가 원래 다음 작업이 CRUD 검증이었다고 지적해 Live 파일럿으로 변경한 작업 순서를 바로잡았다.
- scripts/validate_faq_crud.py에서 원문 HTTP 응답만 통제하고 실제 수신 API/영속큐/소비자/OpenAI임베딩/Qdrant/GPU검색을 연결했다. 합성FAQ2건 추가/수정/삭제와 중복·조회503재시도·삭제 반환차단·옛판본제외·실제벡터0건·원문/캐시정리19개 확인 통과. 운영 관리자 API/BE outbox 네트워크 전체와 구분한다.
- 접수ASGI0.003~0.012초, 추가5.166초, 수정0.257초, 삭제0.053초. 한 시나리오이며 SLA가 아니다. 사전 가짜 외부서비스 테스트1개 통과.
- 첫 실제 실행은GPU시작직후502로 중단, health확인 후 새 결과경로로 재실행했다. 원본 managed-faq-crud-20261031.json, 공유분석 evaluation/results/faq_crud_20261031.md. 운영FAQ/설정변경·커밋·푸시는 하지 않았다. 검증 후GPU중지요청.

## 2026-10-31 관리 FAQ Top3→Live 실제 발화 파일럿

- OpenAI Docs와 기존 SDK/실험 코드를 확인하고 관리 FAQ 어댑터 및 환경변수 전용 실행 옵션을 연결했다. 기존 primary WebSocket/client 위임으로 합성 질문3개를 보내 전사·실제Top3·시간을 보존했다. 관련 가짜 테스트13개 통과.
- 세 문항 모두 검색1회/근거 전달 성공. 이용시간/착불은 근거와 일치했고 취소에는 '첫 자료'와 '즉시 취소 처리됩니다'가 나와 내부 표현/실제 실행 오해 위험을 기록했다. 실제 주문 취소는 수행하지 않았다.
- 검색어를 백엔드가 변환한 뒤 정답이 모두1위여서 앞선 원질문2~3위 조건과 다름을 명시했다. 입력종료→근거이후첫음성 패킷7.202/4.714/5.949초, 마지막출력20.301/11.314/12.349초. 첫패킷은 정답발화시작 보장이 아니다.
- 원본 managed-faq-live-pilot-20261031.json, 공유 분석 managed_faq_live_pilot_20261031.md. 전체95Live/Ragas/운영responses 경로·PBX 검증은 미실행. 임시 파일 소유권 문제는 /tmp 검증 경로에서 해결했고 운영 배포/커밋/푸시는 하지 않았다. 검증 후GPU중지요청.

## 2026-10-31 BM25 설명 복원 후 실제95문항 재검증

- 이전 검증 DB/벡터를 재사용하는 --state-directory를 추가하고 현재 BE 원문이 기존과 같을 때만 실행했다. 문서 벡터 재계산을 막고 질문만 실제 임베딩했다. 운영 경로는 바꾸지 않았다.
- 성공95건/오류0, 후보Hit5=95/95, 리랭크Hit1=91/95, Hit3=95/95, 후보 제한 MRR0.97544. 이용시간 정답은 실제3위로 회복됐고 다른 Top1 정답 여부의 악화는 없다. 전체검색 평균0.270초/p95 0.328초. Live 생성/발화는 포함하지 않는다.
- 첫 시도는 embed_documents 직접 변경으로 embed_query 내부 위임까지 막아95개 RuntimeError가 났다. 무효 원본을 별도 보존하고 원본 객체를 변경하지 않는 QueryOnlyEmbeddings 래퍼로 수정했다. 관련 회귀 테스트2개 통과. 오류 실행을 completed_with_errors로 구분한다.
- 성공 원본 managed-faq-bm25-fixed-20261031.json, 공유 분석 evaluation/results/managed_faq_20261031.md. 실제 질문 임베딩/GPU 재측정은 수행했고 문서 재임베딩/운영 전환/전화/커밋·푸시는 하지 않았다. 검증 후 GPU 중지 요청.

## 2026-10-31 기존 검색 설명을 관리 FAQ의 BM25 전용 설정으로 연결

- 이용시간 FAQ 실제3번/source hash에 기존 설명을 연결한 config/faq-bm25-descriptions.json을 추가했다. FaqIndex/FaqSnapshotSearch가 원문 해시가 같은 설명만 BM25 입력에 적용한다. 벡터 입력·근거 본문·캐시는 변경하지 않는다. 원문 변경 시 오래된 설명은 사용하지 않는다.
- 새 테스트는 설명 로딩 후 벡터 재호출 없음/본문 동일/원문 수정 뒤 설명 제외를 확인한다. 관련20개 및 전체519개 통과(25.26초), 기존 경고1건. 운영 서버에는 반영하지 않았다. 앞선 동일 벡터순위 오프라인 대조에서 후보Hit5는95/95로 회복됐다. 이번 변경으로 실제 리랭킹Top3를 다시 측정한 것은 아니다.

## 2026-10-31 이전 Top5와 신규 FAQ 검색 차이 분리

- 이전 설정의 이용시간 검색 설명을 확인하고 현재 초기 색인은 신규 ID/원문 해시의 설명을 가져오지 않는다는 점을 확인했다. 모델large3072/Kiwi/BM25/RRF0.4/0.6 c60/Top5는 유지됐다. BE 원문은 분류/출처/표시 문자열이 달라졌다.
- 동일 BE 원문과95문항 저장 벡터 순위를 고정하고 BM25 설명만 넣는 오프라인 대조를 했다. 해당 FAQ BM25 미적중→5위, RRF21위→5위, 전체Hit5 94/95→95/95. 설명 미연결이 이번 후보 누락의 직접 재현 요인임을 확인했다. 리랭킹/최종답변은 재평가하지 않았다.
- 비교 코드 scripts/compare_faq_search_inputs.py와 결과 faq-description-ablation-20261031.json을 남겼다. 운영 수정·API/DB 호출·재임베딩은 없었다.

## 2026-10-31 FAQ 중복 재확인

- 운영 AI FAQ 전체 조회32건/hasNext=false. Unicode NFKC·공백 제거·대소문자 정규화 후 같은 질문/같은 답변 그룹은 없었다. 직전 등록 확인 응답과 번호/원문/수정시각도 모두 같았다.
- 이번 확인은 읽기만 수행했다. 중복 의심 번호가 특정되면 의미상 중복을 별도 확인해야 하며 임의 삭제하지 않았다. 원본은 data/private/evaluation/backend-faq-duplicate-check-20261031.json에 보존했다.

## 2026-10-31 실제 BE FAQ32건 색인·95문항 검색 평가

- 별도 manuals_validation_faq_20261031과 임시 상태 DB에서 실제 BE ID로 초기 큐→원문 재조회→GPU 등록 길이 검증→임베딩/색인/APPLIED를 확인했다.32FAQ/32청크, 준비10.527초.
- scripts/validate_managed_faq.py로 기존95문항을 평가했다. 오류0, 후보Hit5=94/95, 리랭크Hit1=91/95, Hit3=94/95, 후보 제한 MRR0.97193. 전체검색 평균0.262초/p95 0.319초. 질문임베딩 평균0.174초/리랭크0.0689초. 생성/발화 평가와 구분한다.
- 저녁 늦은 접수 질문은 이용시간 FAQ가 Top5에서 누락됐다. 착불1건/취소2건은 정답이 각각3/2/2위였다. 새 원문에 기존 MD 검색 설명을 자동 이식하지 않았으며 인과관계 확정이나 평가문항별 수동 보정은 하지 않았다.
- 첫 실행은 시스템 Python으로 httpx2를 찾지 못했다. 명시한 임시 가상환경으로 해결했고 운영 가상환경 패키지목록 해시는 원본 이미지와 동일했다. Qdrant 버전/내부 HTTP 경고를 보존했다.
- 전체 원본은 data/private/evaluation/managed-faq-validation-20261031.json, 공유 분석은 evaluation/results/managed_faq_20261031.md. 실제 임베딩/검증 컬렉션 쓰기는 실행했지만 운영 검색 전환·전화·최종답변 생성·커밋·푸시는 하지 않았다. 검증 후 GPU 중지 요청.

## 2026-10-31 운영 백엔드 초기 FAQ 등록 확인

- 실제 AI FAQ 조회 API에서32건/hasNext=false를 확인했다. 전달 파일의 질문·답변32건이 모두 정확히 일치하고 차이는 없었다. 관리번호는1~30,32,33이며 연속 번호를 가정하지 않는다.
- 응답은 data/private/evaluation/backend-faq-after-registration-20261031.json에 보존했다. 이번 확인은 읽기만 수행했고 색인 반영/검색 정확도 검증과 구분한다.

## 2026-10-31 백엔드 전달용 초기 FAQ 파일

- `docs/handoff/delivery-faq-32.json`을 생성했다. origin/develop-backend의 초기 delivery-faq.json에서 질문/답변32건을 그대로 추출한 JSON 배열이며 UTF-8 BOM 없이 저장했다.
- 필드/건수/빈 문자열과 저장 후 원문 동등성을 확인했다. 표·목록·줄바꿈, 규격별 요금표를 보존했다. BE 번호/시각은 넣지 않았다. 운영 등록과 콘텐츠 정책 재검토를 실행한 것은 아니다.

## 2026-10-31 GPU 등록 길이 검증 API 실제 배포

- 기존 서울 L4 VM의900초 STOP 설정을 확인하고 시작했다. 복구용 소스/이미지를 보존한 뒤12개 파일 묶음으로 새 이미지8a5ce26a8218을 빌드·재시작했다. 모델/고정 리비전은 그대로다. 첫 SCP는 연결 종료로 실패했으나 SSH 정상 확인 후 재전송했다.
- 점검 CLI에 /validate-documents 인증 실패401, 길이 초과422, 짧은 원문 및 고정 토큰 예산 검증을 추가했다. 실제 외부 HTTPS에서 모두 통과했고 기존 리랭킹9회도 기대 FAQ1위였다. 예열5회 평균0.0997초, 동시3회 평균0.1832초/최대0.2565초. 전체 RAG/전화 지연은 측정하지 않았다.
- 로컬 리랭커 계약 테스트11개 통과. 결과는 data/private/gcp/reranker-check-20261031.json. OpenAI/PBX/벡터 DB 호출·BE 최초 이전·운영 AI 플래그 변경·커밋/푸시는 하지 않았다. 검증 후 VM 중지 명령이 완료됐다.

## 2026-10-31 FAQ 관리 8단계: 최초 FAQ 이전 접수

- 실제 BE 계약을 Git에서 확인해 전체 조회(limit100/offset0, 번호 필터 없음)를 추가했다. 관리자 쿠키/인증 헤더를 상속하지 않는 Request를 사용한다.
- `parse_initial_faqs`가 원문/번호/시각/정렬/중복과 완전 응답을 검증한다. hasNext=true는 부분 이전을 시작하지 않고 거절한다. 현재32건을 위한 단일 응답 MVP이며 다중 페이지 전체의 고정 시점 보장은 없다.
- `scripts.bootstrap_faq` 기본은 조회 미리보기다. --enqueue에서만 기존 로컬 영속 큐에 INSERT를 넣으며 번호 집합에 고정 UUID를 사용해 재실행 중복을 막는다. 원문은 소비자가 최신 상태로 다시 읽고 빈 목록은 삭제하지 않는다. 같은 DB/볼륨과 변경 알림 수신 준비가 필요하다.
- 전체518개 통과(30.22초), 기존 langchain-community 경고1건. 실제 운영/API/임베딩 호출·커밋·푸시·배포는 하지 않았다. 테스트는 가짜 HTTP와 임시 SQLite를 사용했다.

## 2026-10-30 FAQ 관리 7단계: 운영 색인 생성과 Live 검색 경계 코드

- `faq_runtime.py`가 관리 전용 Qdrant 컬렉션·SQLite 원문/벡터 캐시·OpenAI large 임베딩·기존 Kiwi/BM25/RRF를 같은 설정으로 구성한다. 기존 MD 컬렉션은 건드리지 않는다. 기동 시 GPU의 새 등록 검증 API가 없거나 고정 Qwen 모델/리비전/토큰 예산이 다르면 실패한다.
- GPU `/validate-documents`는 실제 고정 토크나이저로 원문 길이를 검사한다. 질문 예비256토큰과 경계 여유32토큰을 둔다. 고객 질문이 길면 실제 `/rerank`에서 전체1024토큰을 다시 확인하며 자동 절단하지 않는다. GPU 새 API는 코드에만 추가했고 기존 배포 서버는 갱신하지 않았다.
- `RagService`는 관리 모드에서 활성 FAQ Top5 검색→기존 Qwen 리랭킹→삭제 차단 재확인→최대Top3를 `search_manual` 계약으로 반환한다. 진단 목록도 최종 삭제 차단을 적용한다. 기본 설정에서는 기존 MD 검색을 유지한다.
- 전용 색인 구성, GPU 인증/길이/버전 계약, 관리 검색/삭제 겹침 테스트를 가짜 자원으로 추가했다. 전체513개 통과(26.85초), 기존 langchain-community 경고1건. GPU 배포, BE 초기 전체 이전,95문항/긴 FAQ 정확도·지연과 실제 통화 검증 전에는 receive/process 플래그를 켜지 않는다. 실제 외부 API·운영 DB 호출, 커밋·푸시·배포는 하지 않았다.

## 2026-10-30 FAQ 관리 6단계: 영속 FIFO 자동 소비자

- `faq_processor.py`에서 알림 순서대로 BE 최신 원문을 읽어 문서/검색 입력을 준비하고 관리 색인을 적용한 뒤에만 APPLIED로 기록한다. DELETE는 원문을 다시 조회하지 않는다. 같은 원문의 검증된 검색 설명은 유지하고 원문 변경 시 제거한다.
- 조회·준비·색인·완료 기록 오류는 고정 코드로 RETRY 처리한다. 최초5초, 두 배씩 최대300초로 늘리고 실패한 첫 알림을 뒤 작업이 추월하지 못한다. 완료 커밋 뒤 응답만 유실된 경우에는 APPLIED를 되돌리지 않는다. 재시도 기록 자체가 실패하면 해당 알림을 메모리에서 붙잡고 재기록하며, 재시작 때 PROCESSING을 복구한다.
- 서버 종료 때 실행 중인 동기 작업 스레드가 끝나기를 기다린 뒤 INTERRUPTED로 전환한다. 접수202 직후 소비자를 깨우되 폴링으로도 유실된 깨우기를 보완한다. 삭제는 주기 재점검한다. 이미 CLEANED인 번호의 늦은 포인트는 새 색인 세대 없이 제거한다.
- 앱 기동은 관리 색인 주입과 큐/색인의 파일·컬렉션·모델·차원 일치를 검사한다. 주입이 없거나 다르면 기동 실패한다. 운영 관리 색인 생성·실제 Qwen 토큰 검증·Live 최종 전달 연결은 아직 없으므로 `receive_enabled=false`, `process_enabled=false`를 유지한다.
- 새 가짜 테스트15개를 추가해 전체505개 통과(26.07초). 로컬 SQLite·메모리 Qdrant·가짜 BE/임베딩으로 추가/수정/삭제, 재시도/응답 유실, 스레드 취소, 재시작, 주기 재점검, HTTP202와 종료를 검증했다. 기존 langchain-community 경고1건은 그대로 관측했다. 실제 외부 API·운영 DB·유료 임베딩·커밋·푸시·배포는 하지 않았다.

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
  - `delegation.responses.model`(지금 `gpt-6-luna`)이 GPT-Live 위임에서 되는지.
  - strict 스키마의 `maxLength`가 위임 백엔드에서 받아들여지는지.
- RAG(pgvector)
  - 주문 DB와 데이터베이스·계정을 나눌 것.
  - 지금 `ai-db`에는 주문 계정 하나뿐이다.
- 진행 문구·지시문은 실제 통화를 들어 보며 다듬어야 한다(`prompts/`).
- 등록 고객의 받는 순서: 지금은 "지난번 받는 분 질문"만 앞에 둔다. 순서를 바꾸려면 `app/flow/stages/collecting.py`.
- 아직 없는 기능(AGENTS.md "아직 없는 것")
  - 추가 주문에서 앞 주문과 같은 보내는 분 쓰기.
  - 알림톡, 실제 요금 API, 결제, outbound.

## 2026-10-21

### 바꾼 것
- 백엔드 모델 `delegation.responses.model`을 `gpt-5.4-mini`에서 `gpt-6-luna`로 바꿈(사용자 요청). `reasoning.effort`는 그대로 `low`.

### 남은 것
- `gpt-6-luna`가 GPT-Live 위임에서 되는지, `low` effort를 받는지 실제 통화로 확인.

### 바꾼 것(오후: `spec/scenario.md` 적용)
- 단계를 scenario.md대로 다시 정의
  - `collecting` 하나로 합침(신규·등록 고객은 받는 순서만 다름).
  - 새 단계: `recent_offer`, `find_destination`, `find_origin`, `submitted`(머무르지 않고 바로 넘어감).
  - 하위 흐름(조회·수정·취소·상담원)은 `ending`을 뺀 모든 단계에서 들어감.
- 엔진: 상황별 항목 순서(`order`), 결과별 안내 문구(`variants`), 시작 직후 `stage.entered` 평가.
  - 하위 흐름에서 복귀하면 같은 사건을 돌아간 단계가 다시 본다.
- 도구
  - 지움: `find_saved_places`, `use_saved_place`, `use_recent_receiver`.
  - 추가: `answer_recent_order`, `find_destination`, `answer_same_origin`.
  - `record_order`는 주소가 바뀌고 상세 주소를 같이 말하지 않으면 상세 주소를 비움(다시 묻기).
  - 수정·취소는 실패 이유(불일치·이미 취소됨)를 구분.
- DB
  - `saved_places.kind`(origin·destination) 추가.
  - `latest_order` 추가.
  - update·cancel이 `ok`·`not_found`·`cancelled`를 돌려줌.
- 사용자와 정한 것
  - 출발지·도착지는 종류 칸으로 구분.
  - 수정·취소 대조는 주문번호 + 발신번호.
  - 등록 고객에는 지난 주문도 포함.
  - 저장 동의 뒤 새 주문은 등록 고객 시작 규칙(최근 배송 = 방금 접수한 주문).

### 확인한 것
- DB 없이 도는 테스트 92개 통과. scenario.md의 시나리오 10개와 분기별 테스트 포함.

### 남은 것
- DB 테스트 4개는 Docker가 꺼져 있어 못 돌림.
- 이미 만든 DB에는 `kind` 칸이 없다. `CREATE TABLE IF NOT EXISTS`는 기존 테이블을 고치지 않는다.
  - 운영 데이터가 없으니 `saved_places`를 지우고 다시 띄우면 된다.
  - 테스트 DB도 마찬가지.
- 저장된 배송지 검색은 띄어쓰기를 무시한 부분 문자열 비교다. 오타·별칭(예: "센텀" ↔ "센텀시티")은 못 찾는다.


### 바꾼 것(저녁: 고객 답 판별을 도구 호출에서 분리)
- 문제: 고객 답마다 백엔드 도구 왕복을 거쳐야 상태가 바뀌어 지연이 생김(사용자 지적).
- 대화 상태 전환을 서버의 고객 말 판별로 바꿈(`app/listener.py`).
  - 말이 `listener.pause_ms` 동안 멈추면 작은 모델(`responses.create`, JSON 스키마)로 판별한다.
  - 판별 대상: 이 단계의 답 + 끼어드는 용건.
  - 상태가 바뀌면 바로 `thinking.append`.
  - 판별 중 단계가 바뀌었거나 더 새 판별이 있으면 결과를 버린다. 선택지 밖 출력도 버린다.
- 엔진: `Stage.listen`·`choices`·`on_answer` 추가. 답 처리(접수·저장·최근 배송 채우기 등)는 단계 정의로 옮김.
- 도구
  - 지움(8개): `answer_recent_order`, `find_destination`, `answer_same_origin`, `confirm_order`, `save_places`, `next_request`, `transfer_to_agent`, `end_call`.
  - 남김: `get_state`, `record_order`, `lookup_orders`, `modify_order`, `cancel_order`.
- 저장된 받는 곳·출발지 찾기는 저장된 목록을 판별 선택지로 넘겨 모델이 고르게 함. 문자열 비교 검색은 지움.
- 설정 `[listener]`(모델 `gpt-6-luna`, effort low, pause 600ms 등), 문구 `prompts/flow.toml`의 `classifier`.
- 음성 지시문: 예/아니오 같은 답은 백엔드에 맡기지 않음. 백엔드 지시문: 기록·주문 작업만.
- 안전장치 변경(AGENTS.md)
  - 접수·저장·상담원 전환은 그 단계 확인 질문의 판별 결과로 실행.
  - 통화 종료도 고객의 종료 요청 판별로 바로 진행한다(이전에는 확인을 한 번 더 받았음).
  - 수정·취소만 `customer_confirmed`.

### 확인한 것
- GPT-Live `triggers`(decisions)·Decision API는 SDK 타입에는 있으나 공개 문서에 없음. 미확인이라 쓰지 않음.
- 공식 문서 권장 방식(앱이 받아쓰기를 모아 작은 모델로 판별 → `thinking.append`)을 따름.
- 테스트 93개 통과(DB 포함). 테스트 DB는 새 스키마로 다시 만듦.

### 남은 것
- 판별 지연·정확도는 실제 통화로 확인. 조정할 곳: `listener.pause_ms`·모델·effort.
  - 말이 멈추는 기준이 짧으면 말이 끝나기 전에 판별하고, 길면 늦다.
- 판별 모델은 백엔드와 같은 `gpt-6-luna`(사용자 지정). 판별 지연·비용을 실제 통화로 확인.
- 판별은 고객 말 한 덩어리마다 모델을 한 번 부른다. 비용 확인 필요.

## 2026-10-21 (계획 변경: PostgreSQL 제거, 백엔드 API, Qdrant)

### 바꾼 것
- PostgreSQL을 쓰지 않음
  - 지움: `app/db.py`, `app/schema.sql`, `tests/test_db.py`, psycopg 의존성, compose의 `ai-db`.
- 고객·주문·배송지는 별개의 백엔드 서버 API로 읽고 씀(사용자 결정).
  - API 제안서: `spec/backend-api.md`.
  - 클라이언트: `app/backend_api.py`(`openai`에 딸린 `httpx2`, `BACKEND_API_URL`).
  - 통화 시작 때 한 번에 받는 것: 최근 배송, 저장된 배송지(종류별).
  - 접수번호는 백엔드가 발급. 접수 요청에 `Idempotency-Key`(`세션-n번째`)로 재요청 중복을 막음.
  - 전화번호는 URL에 넣지 않고 본문으로. 경로의 접수번호는 인코딩(`../` 차단).
- 코드 이름 `db` → `backend`. 설정 `[storage]` → `[backend]`(timeout_sec 추가, 풀 크기 제거). `order_prefix` 제거(번호 형식은 백엔드).
- 판별한 답 처리 중 백엔드가 실패하면(접수·저장 등): 상태는 그대로 두고 음성 모델에 오류 안내(`prompts/flow.toml` `answer_error`).
- Qdrant: `ai/compose.yaml`에 서비스만 추가(`qdrant/qdrant:v1.13.4`, internal 네트워크, 볼륨, `QDRANT_API_KEY`). 컬렉션·코드는 RAG 담당자 몫.
  - `docs/rag-handoff.md`를 Qdrant 기준으로 다시 씀.
- 문서: AGENTS.md(스택·저장·안전장치·표), spec(concurrency·monitor·server-config·tools·scenario).

### 확인한 것
- `openai` 3.35는 `httpx`가 아니라 `httpx2`에 의존한다. FastAPI 테스트 클라이언트도 이걸로 동작한다.
- 테스트 98개 통과. 백엔드 API 클라이언트는 가짜 HTTP 전송으로, 흐름은 가짜 백엔드로 시험.
- Qdrant 태그 `v1.13.4` 존재 확인. compose 설정 검증 통과.

### 남은 것
- 백엔드 담당자가 정할 것: API 확정, 인증 방식, 접수번호 형식, 요금 계산 주체, 응답 속도 목표.
  - 통화 시작 조회는 accept 전이라 빨라야 함.
- 인증이 정해지면 `app/backend_api.py`에 헤더, compose·`.env.example`에 변수 추가.
- 백엔드 API가 없으면 통화는 신규 고객으로 시작하고 접수가 실패한다. 실제 통화 전에 백엔드가 떠 있어야 함.

### 바꾼 것(PBX 통화 종료 웹훅)
- 사용자 요구: 통화가 끝나면 웹훅이 와서 세션을 종료해야 함. OpenAI에는 통화 종료 웹훅이 없음(SDK 확인). 그래서 PBX가 보내는 것으로 정함(사용자 결정).
- `POST /pbx/webhook/call-ended`(`app/pbx.py`)
  - SIP Call-ID로 통화를 찾아 바로 hangup.
  - 서명: HMAC-SHA256 + 타임스탬프, 비밀값 `PBX_WEBHOOK_SECRET`.
  - accept 중에 오면 accept가 끝나는 대로 끊고 sideband는 열지 않음.
- 통화 객체에 `sip_call_id`·`pbx_ended`, 레지스트리에 Call-ID 조회.
- 설정 `[pbx] webhook_tolerance_sec`. compose·`.env.example`에 `PBX_WEBHOOK_SECRET`.
- `spec/pbx-sip.md`에 PBX 쪽에 전달할 형식(제안)을 씀.

### 확인한 것
- 테스트 103개 통과(`tests/test_pbx.py`: 정상 종료·중복·모르는 통화·accept 중 종료·서명 오류·비밀값 없음).

### 남은 것
- PBX 담당자에게 형식 전달·확정.
- PBX가 보는 Call-ID와 OpenAI 웹훅 `sip_headers`의 Call-ID가 같은지 실제 통화로 확인.
- `ai/.env`에 `PBX_WEBHOOK_SECRET` 추가(PBX와 같은 값).
- 리버스 프록시에서 `/pbx/webhook/call-ended` 공개.

## 2026-10-22 (상태 엔진을 LangGraph로)

### 바꾼 것
- 사용자 결정: 시나리오 분기 구조에 LangChain 계열을 쓴다. LLM 호출은 openai SDK 그대로(gpt-live-1, gpt-6-luna).
  - 그래서 쓰는 것은 `langgraph`(`StateGraph`) 하나. `langchain`·`langchain-openai`는 넣지 않음.
- 의존성: `langgraph>=1.2.16` 추가(langchain-core·langsmith 등이 따라와 lock 패키지 29 → 53개).
- `app/flow/engine.py`: 전이 실행부(`start`·`apply`)를 LangGraph 그래프 실행으로 바꿈.
  - 기동 시 `engine.build()`가 단계 정의로 그래프를 만든다(단계 = 노드, `check_definitions`에서 검증 뒤).
  - 사건 하나 = `ainvoke` 한 번. 노드(`_step`)가 전이(가드)를 보고 `Command(goto=…)`로 옮김.
  - 그래프 상태(`Step`)는 단계·사건·도구 이름뿐. 통화 객체는 `context`로 넘김. 체크포인터 없음.
  - `MAX_HOPS`는 `recursion_limit`(`MAX_HOPS + 1`)로. 넘으면 지금처럼 `FlowError`.
  - 노드마다 `destinations`를 적어 `get_graph().draw_mermaid()`로 흐름도를 만들 수 있게 함.
- `start`·`apply`가 async가 되어 호출부 4곳에 await(`app/call.py`, `app/dispatcher.py`, `app/listener.py` 2곳).
- 단계 정의(`app/flow/stages/`), 도구, 디스패처, 판별기, FastAPI는 그대로.
- 문서: `spec/flow.md`(엔진 = LangGraph, 실행 방식·규칙), `spec/concurrency.md`(그래프 공유·async 노드), AGENTS.md(스택·구조·안전장치에 LangSmith 추적 끔).

### 확인한 것
- langgraph 1.2.16: openai 3.35.1·Python 3.14와 충돌 없이 설치.
- 실행으로 확인한 동작(스크래치 예제)
  - `ainvoke`에서 동기 노드·동기 라우터는 다른 스레드에서 돈다. 그래서 노드·라우터는 모두 async.
  - `context`로 임의 객체(통화 객체)를 넘길 수 있다(`context_schema` 없이).
  - `recursion_limit=L`이면 노드 실행 L-1번까지만 된다.
- 오버헤드: 사건 하나에 약 0.8~1.4ms(전이 1~4번).
- 테스트 106개 통과
  - 기존 103개는 시나리오 데이터를 고치지 않고 그대로 통과.
  - 추가 3개: 흐름도 엣지가 전이·하위 흐름·복귀를 모두 그리는지, `MAX_HOPS` 한도(4번 이동은 되고 5번째에서 `FlowError`).
- 실제 단계로 만든 그래프: 노드 15개(START·END 포함), 엣지 132개.
- 이전 엔진과 비교(일회성 스크립트, 저장소에 넣지 않음)
  - 이전 엔진(HEAD)과 새 엔진에 같은 무작위 통화 1,800개(행동 41,064개)를 넣음.
  - 행동마다 단계·복귀 단계·전이 기록·임시 주문·도구 결과가 모두 같았음.
  - 13개 단계를 모두 지나갔고, 서로 다른 전이는 138가지.
  - 비교가 실제로 차이를 잡는지도 확인: 이전 엔진의 "복귀 후 같은 사건 다시 보기"를 일부러 끄자 불일치를 잡음.
- Docker 데몬이 꺼져 있어 이미지 빌드는 못 함. 대신 잠긴 런타임 패키지 46개가 Linux x86_64·Python 3.14 바이너리 wheel만으로 설치되는 것을 확인(`uv pip install --dry-run --only-binary :all:`).

### 남은 것
- Docker 이미지 빌드·기동 확인(데몬을 켜고 `docker compose build`).
- 실제 통화로 회귀 확인(분기 동작은 그대로여야 함).
- (선택) 관제 화면에 흐름도(mermaid) 보여 주기.

### 바꾼 것(LangGraph Studio)
- 사용자 결정: 시나리오 분기를 직관적으로 보도록 LangGraph Studio를 세팅(관제 화면 흐름도 대신).
- dev 의존성 `langgraph-cli[inmem]`(lock 패키지 53 → 88개, 운영 이미지는 `--no-dev`라 영향 없음).
- `langgraph.json`: 그래프 `call_flow` = `studio/graph.py:graph`, `LANGSMITH_TRACING=false` 고정.
- `studio/graph.py`(개발 전용, 이미지·Docker 빌드 컨텍스트에서 뺌)
  - 스레드 하나 = 가짜 통화 하나. 실행마다 보고 하나(customer로 시작, 그다음 answer·intent·tool 중 하나).
  - 보고 처리는 실제 코드(`call.prepare`, `listener.apply_answer`, `dispatcher.dispatch`)를 그대로 부르고, `engine.apply`를 잠시 바꿔 사건만 모음.
  - 모은 사건을 실제 엔진 노드(`engine._step`)로 단계 노드마다 흘려보내 Studio에서 경로가 노드별로 보임.
  - 결과: 단계·다음 질문·답 선택지·허용 도구·기록된 값·`record_order` 예시 인수·지나온 경로.
  - 고객 상황·가짜 백엔드는 테스트의 것을 그대로 씀.
- `.gitignore`·`.dockerignore`에 `.langgraph_api/`(dev 서버 상태) 추가.
- 문서: `spec/flow.md`("LangGraph Studio로 보기"), AGENTS.md(dev 의존성, 문서 표, 추적 고정).

### 확인한 것
- 공식 문서
  - Studio 화면은 smith.langchain.com에서 로컬 서버(`baseUrl`)로 붙는다.
  - `LANGSMITH_TRACING=false`면 데이터가 로컬 서버 밖으로 나가지 않는다.
  - Studio 연결에 LangSmith API 키가 필요하다고 되어 있다.
- 한국어 Windows에서 `langgraph dev`는 cp949 때문에 기동 실패 → `PYTHONUTF8=1`로 해결.
- 실제 `langgraph dev`(Python 3.14)를 띄워 HTTP API로 확인
  - 스레드를 만들고 한 통화(시작 → 기록 → 접수 → 저장 거절 → 종료)를 실행함.
  - 스레드에 상태가 이어지고, 노드가 report → 단계 노드들 → done 순서로 기록됨.
  - LangSmith API 키 없이도, `.env` 없이도 서버가 뜸.
- 테스트 119개 통과
  - 추가 13개(`tests/test_studio.py`): 시나리오 12건이 Studio 그래프에서도 같은 경로.
  - 한 실행에서 단계 노드가 하나씩 지나가는지, 잘못된 입력은 오류 결과로 돌려주는지.

### 남은 것
- Studio 웹 화면 연결은 사용자 계정으로 확인(LangSmith 로그인 필요, 키가 필요하면 `LANGSMITH_API_KEY` 환경변수).
- Studio의 되감기·포크는 가짜 통화에 반영되지 않음(새 스레드로 다시 시작).

## 2026-10-22 (AI 서버 Lightsail 인스턴스: Jenkins 설치)

### 바꾼 것
- Lightsail(Ubuntu 24.04, x86_64, RAM 16GB) 인스턴스에 설치: Docker Engine 29.9 + compose plugin(Docker 공식 apt 저장소), OpenJDK 21, Jenkins LTS 2.580.1(공식 apt 저장소).
- `jenkins`·`ubuntu` 사용자를 `docker` 그룹에 넣음(Jenkins가 `docker compose` 직접 실행).
- nginx·certbot은 하지 않기로 함(HTTPS 불필요하다고 사용자 결정).
- `ai/Jenkinsfile`: `develop-ai` push(GitLab 웹훅) → 작업공간의 `ai/`에서 `docker compose --env-file /srv/dva-ai/.env up -d --build --wait`. 루트 `Jenkinsfile`(팀 CI)은 건드리지 않음.
- 서버에 `/srv/dva-ai/.env`(jenkins 소유, 600, 빈 파일) 생성. 값은 사용자가 채운다.
- Jenkins URL `http://3.37.162.168:8080/` 확인, 역방향 프록시 경고(`ReverseProxySetupMonitor`) 끔(프록시 없음).
- Jenkins job `dva-ai-deploy` 생성(일회용 init Groovy, 실행 후 삭제): SCM `develop-ai`, Script Path `ai/Jenkinsfile`, 자격 증명 ID `gitlab-ssafy`, GitLab push 트리거(`develop-ai`만, 비밀 토큰은 서버 `/root/dva-ai-webhook-token`).
- 확인: 맞는 토큰 200, 틀린 토큰 401, 다른 브랜치 push는 빌드 안 됨.
- job `dva-ai-deploy`는 일단 비활성화(사용자 요청). 사용자가 직접 돌린 #1은 GitLab 인증 실패(토큰 대신 비밀번호로 추정).
- 서버 시간대 Asia/Seoul. `compose.yaml`의 `ai`에 `TZ: Asia/Seoul`(python:3.14-slim에 tzdata 있음 확인). 앱 코드에 로컬 시각 의존은 없어 로그 시각만 바뀐다.
- nginx 1.24 설치. 80은 열림, 443은 닫힘.
- 사용자가 IP 주소용 Let's Encrypt 인증서 발급(`/etc/letsencrypt/live/3.37.162.168`, `shortlived` 6일, webroot 갱신). nginx를 80(인증 경로 + 나머지 HTTPS로 301)·443(프록시, SSE 버퍼링 끔) 두 블록으로 정리. 갱신 후 `systemctl reload nginx` 하는 deploy hook 추가. `certbot renew --dry-run` 성공.
- 확인: 밖에서 HTTPS 인증서 검증 통과(앱이 없어 502). 443은 사용자가 Lightsail 방화벽에서 엶.
- 인증서를 발급 후 3일째 갱신: 갱신 설정에 `renew_before_expiry = 88 hours`(수명 160시간 - 72시간). snap 타이머가 하루 두 번(03:23, 19:36 KST)이라 실제 갱신은 3일 경과 후 첫 타이머. 첫 갱신 예상 2026-10-25 19:36.
- certbot은 snap 5.8.0만 남김(apt 2.9.0은 purge, `/usr/bin/certbot` → `/snap/bin/certbot` 링크). 갱신 타이머는 `snap.certbot.renew.timer` 하나.
- nginx `sites-available/default`를 server 블록 하나로 정리(기본 블록 안에 새 설정이 붙어 `duplicate listen` 오류였음, 원본은 서버 `/root/nginx-default.bak.*`): `/.well-known/acme-challenge/` → `/var/www/certbot`, 나머지 → `127.0.0.1:8000`, `/monitor/api/stream`은 버퍼링 끔. 확인: 인증 경로 응답, `/`는 앱이 없어 502.

### 확인한 것
- Jenkins apt 저장소 서명 키가 `jenkins.io-2026.key`(지문 `5E386EADB55F01504CAE8BCF7198F4B714ABFC68`)로 바뀌어 있음. 2023 키로는 `NO_PUBKEY 7198F4B714ABFC68`.
- `jenkins` 사용자로 `docker ps` 성공. Jenkins는 8080에서 대기, 외부에서는 Lightsail 방화벽에 막혀 닿지 않음.

### 남은 것
- `/srv/dva-ai/.env` 값 채우기, Jenkins 자격 증명 `gitlab-ssafy` 등록, GitLab 웹훅 등록, `ai/Jenkinsfile`을 `develop-ai`에 반영, 첫 배포 확인.
- Jenkins 로그에 `github-branch-source` 플러그인 로드 실패가 있음(쓰지 않음, 배포와 무관).
- 배포 전 테스트 stage 없음(서버에 uv 없음). 필요하면 추가.
- OpenAI 웹훅은 공인 HTTPS 주소가 필요함. TLS를 어디서 처리할지 확인 필요.

## 2026-10-26

웹훅 주소·PBX 종료 웹훅·`app/` 구조 정리, LangGraph 브랜치 머지, Jenkins CI·Lightsail 배포. 아래는 하루가 끝난 시점(`develop-ai` `6d3b148`)의 최종 상태 기준.

### 바꾼 것
- 웹훅 주소(`3d81a32`)
  - 전화 수신(OpenAI가 보냄): `POST /openai/webhook` → `POST /api/webhooks/openai/call-incoming`.
  - 통화 종료(PBX가 보냄): `POST /pbx/webhook/call-ended` 그대로. 백엔드 서버가 보내게 바꾸려다 취소.
  - `.gitignore`에 `.langgraph_api/`(LangGraph Studio 개발 서버 상태).
- 브랜치
  - `refactor/langchain` → `refactor/langgraph`로 이름 바꿔 푸시, `develop-ai`에 머지. 원격 `refactor/langchain`·`refactor/langgraph`는 머지 때 삭제됨.
  - GitLab에서 `WORKLOG.md` 충돌을 풀며(`a7eac34`) 위 웹훅 주소 기록이 빠졌다. 이 항목으로 되살림.
- `app/` 웹훅 정리(`716ea24`)
  - `app/webhook.py` → `app/webhooks/openai.py`, `app/pbx.py` → `app/webhooks/pbx.py`.
  - 앱 공용 객체 `Services`를 `app/services.py`로. PBX 종료 때 세션 끊기를 `sideband.hangup_now`로 옮겨 함수 안 import(순환 회피)를 없앰.
- PBX 통화 종료 웹훅(`b481289`): PBX가 팀 백엔드에 보내는 것과 같은 본문을 우리에게도 보낸다.
  - 인증: HMAC 서명(`X-Pbx-*`) → `Authorization: Bearer <PBX_WEBHOOK_SECRET>`(상수 시간 비교). `[pbx] webhook_tolerance_sec` 삭제.
  - 본문: PBX 형식(`callFrom`·`endedAt` 필수, `recordingId` 기록, `recordingUrl` 등 나머지 무시).
  - 통화 찾기: SIP Call-ID가 없어 발신번호로. `endedAt` 전에 시작한 진행 중 통화만 끊는다(웹훅이 녹취 준비 뒤 몇 초 늦게 와서, 그사이 같은 번호로 다시 건 통화를 보호).
  - SIP Call-ID 수집 코드 삭제. 발신번호 정규화를 `call.normalize_phone`으로 빼서 SIP `From`과 `callFrom`이 같이 씀.
- Jenkins CI·배포(`18ff124` `6114b5b` `13334bf` `20edfa5` `1ae73a8` `e3e6ebc`)
  - 예전 `ai/Jenkinsfile`은 `agent any`라 레이블 전용 노드만 있는 팀 Jenkins에서 대기열에 머물렀다. 팀 최신 Jenkinsfile을 바탕으로, 백엔드 Jenkinsfile(`develop-backend`) 방식에 맞춤.
  - 흐름: `linux-docker-builder` 노드 → 이미지 빌드(`dva-ai-server:<커밋12자리>-<빌드번호>`, linux/amd64) → 그 이미지 안에서 pytest → 접속 확인(`--verify-only`) → `DEPLOY_LIGHTSAIL`을 체크했을 때만 배포.
  - 자격 증명: SSH는 백엔드와 같은 `dva-lightsail-ssh`, 비밀값은 Jenkins Secret file `dva-ai`. 배포 때 서버의 `/home/ubuntu/dva-ai/shared/.env`(600)로 올린다.
  - `ai/deploy/upload.sh`: 고정 호스트 키(`deploy/known_hosts`, `StrictHostKeyChecking=yes`)로 `13.209.59.180`에 SSH. 이미지는 `docker save | docker load`, 릴리스(`compose.yaml`·`config/`·`prompts/`·`deploy.sh`·`compose.deploy.yaml`·`release.env`)는 `releases/<version>`에.
  - `ai/deploy/deploy.sh`(서버): `docker compose --project-name dva-ai up --no-build --pull missing --wait`. 성공하면 현재·직전 릴리스 기록, 그 두 이미지만 남김. 실패하면 직전 릴리스로 복구. `sudo -n docker`, `flock`.
    - `--pull never`였을 때 서버에 Qdrant 이미지가 없어 빌드 #12 배포가 실패했다 → `--pull missing`(AI 이미지는 미리 load 해 두므로 받지 않음).
  - 백엔드와 연결: 백엔드(`ci/backend-external-ai`)가 정한 외부 네트워크 `dva-prod_ai_net`에 별칭 `ai`로 붙는다(`compose.deploy.yaml`, 배포 때만). 백엔드 → `http://ai:8000`, AI → `BACKEND_API_URL`(`http://backend:3000`).
    - 새 AI가 정상 기동하면 백엔드 스택이 띄웠던 예전 `dva-prod-ai-1`을 멈춘다(지우지 않음, `docker start`로 되살릴 수 있음).
  - `compose.yaml`: `ai`에 `image: ${AI_IMAGE:-dva-ai:local}`, 호스트 포트 `${AI_PORT:-8000}`. `.env.example`에 `AI_PORT`, `.dockerignore`에 `deploy`.
  - 이미지 이름은 `dva-ai-server`(백엔드가 빌드하던 `dva-ai`와 겹치지 않게). 다른 관리자의 서버라 `docker image prune`은 쓰지 않음.
- 문서: `spec/pbx-sip.md`(두 웹훅 구현 경로, 종료 웹훅 절), `docs/rag-handoff.md`(`Services` 위치).

### 확인한 것
- `develop-ai`(`6d3b148`)에서 `uv run pytest -q` 120개 통과, 두 배포 스크립트 `bash -n` 통과.
- 앱 기동·웹훅 응답: `/health` 200, 수신 웹훅 서명 없음 400, 옛 주소 `/openai/webhook` 404.
- `docker compose config`(가짜 env)로 `compose.yaml` + `compose.deploy.yaml` 병합과 `AI_IMAGE`·`AI_PORT` 치환.
- `deploy.sh`를 가짜 docker로 시험: 첫 배포, 두 번째 배포(직전 기록·이미지 정리), 실패 시 직전 릴리스 복구.
- PBX 담당 회신
  - 회사 번호를 OpenAI 프로젝트로 넘기는 SIP 설정 완료.
  - 통화 종료 웹훅 본문: `recordingId`·`callFrom`·`callTo`(두 070 번호 구분)·`startedAt`·`endedAt`·`durationSeconds`·`recordingUrl`. 녹취가 준비된 뒤 보내 끊긴 시점보다 몇 초 늦다.
  - 재전송: 2xx가 아니거나 연결 오류·30초 타임아웃이면 5초 간격 최대 5번. 리다이렉트는 따라가지 않는다 → 주소는 정확히 `https://…/pbx/webhook/call-ended`(끝 `/` 없음, `http` 아님). 우리 서버는 모르는·끝난 통화에도 200, 중복은 한 번만 처리.

### 남은 것
- OpenAI 프로젝트에 웹훅 `https://<도메인>/api/webhooks/openai/call-incoming` 등록(`live.transport.incoming` 구독), `OPENAI_WEBHOOK_SECRET`을 Jenkins `dva-ai`에.
- 호스트 Nginx(백엔드 담당)에서 `/api/webhooks/openai/call-incoming`·`/pbx/webhook/call-ended`를 AI(`127.0.0.1:${AI_PORT}`)로.
- PBX 담당에 우리 종료 웹훅 주소와 Bearer 토큰(`PBX_WEBHOOK_SECRET`과 같은 값) 전달, 우리 쪽 발송 설정 확인.
- 실제 통화로 확인
  - PBX `callFrom`이 OpenAI 웹훅 SIP `From`의 발신번호와 같은지(다르면 종료 웹훅이 통화를 못 찾는다).
  - 고객이 먼저 끊으면 sideband `session.closed`(`remote_hangup`)가 바로 오는지.
- Jenkins `DEPLOY_LIGHTSAIL` 배포가 끝까지 성공하는지(#12 이후 `--pull missing` 반영본), 백엔드 → AI(`http://ai:8000`)·AI → 백엔드 호출 확인.

## 2026-10-26 (첫 배포, 웹훅 연결, 실제 통화)

위 "남은 것"을 처리한 기록. 서버 설정(호스트 Nginx·인증서)은 저장소가 아니라 서버에서만 바꿨다.

### 바꾼 것
- 첫 배포: Jenkins `dva-ai` #14(`DEPLOY_LIGHTSAIL`, `6d3b148a517a-14`) 성공.
  - Qdrant 이미지를 서버에서 처음 받음(`--pull missing`).
  - `dva-ai-ai-1`이 `dva-prod_ai_net`에 별칭 `ai`로 붙고, 예전 `dva-prod-ai-1`은 멈춤(지우지 않음). 되돌리기: `sudo docker stop dva-ai-ai-1 && sudo docker start dva-prod-ai-1`.
- 호스트 Nginx(`/etc/nginx/sites-available/dva-ip`, 원본은 백엔드 `infra/https/https.conf`). 고칠 때마다 `/root/dva-ip.bak.*`로 백업.
  - `POST /api/webhooks/openai/call-incoming`, `POST /pbx/webhook/call-ended` → AI(`127.0.0.1:8000`). 기존 PBX 웹훅 블록과 같은 형식(POST만, 본문 16k, 10초).
  - PBX는 백엔드 주소(`/api/webhooks/pbx/call-ended`)로만 보내고, 백엔드는 DB에 저장만 하고 AI에 넘기지 않는다. 그래서 그 경로에 `mirror`를 달아 같은 요청(본문·Bearer 토큰)을 AI `/pbx/webhook/call-ended`로 복사. PBX가 받는 응답은 백엔드 응답 그대로. 백엔드 `PBX_WEBHOOK_TOKEN`과 우리 `PBX_WEBHOOK_SECRET`이 같은 값이라 인증도 통과(해시로만 비교).
- OpenAI 웹훅 주소를 `https://13-209-59-180.sslip.io/api/webhooks/openai/call-incoming`으로.
  - `https://13.209.59.180/...`(IP 주소 URL)로는 테스트 전송이 "Failed to POST to webhook endpoint"였고, 서버 443에 TCP 연결(SYN)조차 오지 않았다(tcpdump, 테스트 3번).
  - 같은 서버를 이름(sslip.io: 이름에 적은 IP를 돌려주는 공개 DNS)으로 바꾸자 바로 `9.129.x.x`에서 연결이 왔다. OpenAI가 IP 주소 URL로는 보내지 않는 것으로 본다(공식 문서에서는 못 찾음).
  - Let's Encrypt 인증서 `dva-sslip`(webroot, 기존 갱신 타이머·nginx reload 훅 그대로) 발급. 이 이름의 443 블록은 전화 수신 웹훅만 열고 나머지는 404.

### 확인한 것
- 백엔드 → AI: 백엔드 컨테이너에서 `ai`가 새 컨테이너 IP 하나로만 풀리고 `/health` 200.
- 실제 통화 2번: 수신 웹훅 200 → accept 200 → 통화 → 고객이 끊음 → PBX 종료 웹훅(mirror) 200 → 약 2.5초 뒤 sideband 종료로 `ended`(`remote_hangup`). 남는 세션 없음.
  - PBX `callFrom`으로 통화를 찾았다(`pbx_ended` 기록됨). 발신번호 형식은 맞다.
  - 종료 웹훅 뒤의 `hangup`은 이미 닫힌 세션이라 404. 동작에는 문제없고 모니터에 오류로만 남는다.
- 테스트 전송 이벤트(`live_u0_abc123`)는 서명 검증까지 통과하고 accept만 503(없는 세션).

### 남은 것
- 백엔드에 `POST /internal/ai/callers/context`가 없어 404("고객 조회 실패"). 통화는 최근 주문·배송지 없이 진행된다. 주문 저장 등 다른 백엔드 API도 같은지 백엔드 담당과 확인.
- 호스트 Nginx 변경(AI 웹훅 경로, mirror, sslip.io 블록)을 백엔드 저장소 `infra/https/https.conf`에도 반영. 안 하면 그 파일로 다시 설치할 때 사라진다.
- `hangup_now`에서 404를 "이미 끝남"으로 처리해 오류로 남기지 않기.
- Jenkins credential `dva-ai`의 `.env`가 CRLF. compose는 읽지만 셸에서 `source`하면 값 끝에 `\r`이 붙는다. LF로 다시 올리기.
- sslip.io는 외부 무료 서비스(보장 없음). 오래 쓸 거면 정식 도메인으로.
- PBX 종료 웹훅 토큰을 바꿀 때는 백엔드와 AI 값을 함께 바꾸기(다르면 AI 쪽 mirror만 조용히 401).

## 2026-10-27

오늘 세션 세 곳의 기록: 이 저장소 작업(AI 서버), Jenkins 자동 배포(다른 세션), 주소 보정 모듈(`kakao_map_test`, address-stt-eval-plan 세션, 아래 별도 항목).

### 바꾼 것
- 10-26 기록 커밋: `docs/worklog-2026-10-26`에 첫 배포·웹훅 연결·실제 통화 확인 기록(`9e01a10`) → 병합(`7a76f9b`).
- Jenkins 자동 배포(`ci/ai-auto-deploy`, `f77e3f2` → 병합 `cca6112`): `DEPLOY_LIGHTSAIL` 파라미터와 배포 단계 조건을 지우고, 중복이던 `Verify Deployment Access` 단계도 지움(`upload.sh`가 배포 전에 같은 확인을 함). 이제 `develop-ai`에 병합·push될 때마다 빌드·테스트가 통과하면 Lightsail에 배포된다.
  - 배포마다 컨테이너를 다시 만들어 진행 중 통화가 끊긴다(시연 중 병합 금지). `ai/` 아래 문서만 바꿔도 재배포된다(막으려면 Jenkins job 경로 필터에서 `ai/docs/` 제외).
- PoC(`PJT03/ai-server`)와 지금 LangGraph 서버 비교(코드 변경 없음): 구조(분기 주체가 백엔드 도구 → 서버 판별)보다 말하는 쪽 문구 차이가 컸다(진행 상태 문구가 얇음, 되읽기 규칙이 반대, 상세주소 따로 질문, 등록 고객 인사 없음, 백엔드 실무 규칙 빠짐). LangGraph 구성·남은 차이·위험(R1~R11)을 정리한 보고서(Artifact "디포스트콜 LangGraph 점검")를 만들었다. 아래 발화·상담원·판별 작업은 이 비교에서 나왔다.
- 고객 답 판별 지연 측정(`app/listener.py`, `app/call.py`)
  - 마지막 받아쓰기 조각 시각(`heard_at`)부터 진행 상태를 보낼 때까지를 `total_ms`로 판별 기록에 남김. 멈춤 대기(`pause_ms`) + 판별 모델 + 답 처리(접수 등)를 모두 포함.
  - 판별마다 INFO 로그 한 줄: 단계·answer·intent·모델 시간(`elapsed_ms`)·`total_ms`·진행 상태가 바뀌었는지. 고객 말은 로그에 남기지 않음.
  - 관제 화면 도구 목록의 listener 항목에 "말 끝→진행 상태" 시간 표시.
- 가짜 백엔드로 배포(`app/mock_backend.py`, `[backend] mock = true`, 사용자 결정)
  - 백엔드 DB 연동 전이라 `/internal/ai/*`가 404(고객 조회·접수 실패). 연동 전까지 메모리 가짜 백엔드로 진행.
  - `tests/conftest.py`의 `FakeBackend`를 그대로 옮김(테스트도 같은 것을 씀). `mock = true`면 `BACKEND_API_URL` 없이 뜨고 기동 로그에 경고.
  - 재시작·재배포하면 주문·배송지가 사라진다. 같은 번호로 접수·저장한 뒤 다시 걸면 등록 고객 흐름을 볼 수 있다.

- 상담원 연결 보강(PoC 수준으로)
  - 판별 용건 `help`(접수·조회·수정·취소로 처리할 수 없는 요청·불만) → `handoff` 단계에서 서버가 먼저 제안(`handoff.offer`). 고객이 직접 요청하면 한 번만 확인.
  - 답 처리(접수·저장)가 두 번 연달아 실패하면 오류 안내 대신 상담원 연결을 제안. `answer_error`에서 "상담원 연결을 안내" 문장 삭제(음성 모델이 먼저 물으면 답이 엉뚱한 단계로 판별되므로).
  - 연결 동의 후 마무리 인사 대신 "상담원에게 연결해 드리겠습니다. 잠시만 기다려 주세요."(`ending.handoff`).
  - refer 실패 시 고객을 기다리게 두지 않고 사과·마무리 인사(`ending.refer_failed`) 후 hangup.
  - `voice.md`: 처리할 수 없는 요청에 답을 지어내지 않기, 진행 상태에 없는 예/아니오 질문 금지.
- 고객 끊김 안전장치(`app/sideband.py watch_idle`)
  - 고객이 끊으면 OpenAI가 세션을 먼저 닫는다(오늘 PBX 종료 웹훅 뒤 hangup이 모두 404 `session_id_not_found`). 그 신호와 PBX 웹훅이 모두 없을 때를 위해 고객 말이 `idle_hangup_sec`(60초) 없거나 통화가 `max_call_sec`(1200초)를 넘으면 마무리 인사 후 끊는다.
  - PBX 종료 웹훅 뒤 hangup 404는 "이미 끝남"으로 처리(오류로 남기지 않음). 통화 종료 이유를 INFO 로그로 남김.

- 발화를 PoC 수준으로(`prompts/voice.md`·`flow.toml`·`backend.md`)
  - `voice.md`를 PoC `live.md` 기준으로 다시 씀: 인사 형식(처음·등록 고객), 확인은 접수 직전 한 번(그 전 되읽기 금지, 기존 지시와 반대였음), 마지막 확인 요약 예시·번호 읽기 규칙, 주소 듣기("인동 구길"→"9길"), 전화번호 규칙, 저장된 배송지 대사, 접수·저장 안내, 여러 주문, 맞장구·끼어들기. 도구로 분기하던 PoC 문장은 지금 구조(서버 판별)에 맞게 바꿈.
  - `flow.toml`: 항목·단계 문구를 PoC 대사로(따옴표 대사), 그다음 항목 안내(`progress_then`), 접수·알림톡·저장 안내 대사, 요금 3,500원 표기, 빈 값은 "없음".
  - `backend.md`: 주소 기본·상세 나누기(같은 호출, 없으면 ""), 수량 기본 1개, 접수번호 Q 변환, 표시용 글자를 인수에 넣지 않기.
  - 코드: 저장된 곳에서 온 번호·상세주소와 발신번호는 진행 상태에 값 대신 표시(`Call.recorded`, `use_place`), 통화 정보에 등록 고객 성함·첫 질문, 최근 배송을 "대구 수성구의 김도윤 님"처럼, 발신번호로 연락받겠다는 답을 서버가 판별해 기록(`collecting` 선택지 `use_caller`).

### 확인한 것
- `uv run pytest -q` 132개 통과. 추가한 테스트: 판별 `total_ms ≥ elapsed_ms`, 가짜 백엔드 기동, 상담원 제안·거절 복귀, 반복 실패 시 제안, refer 실패, 무응답 종료·말하면 유지, hangup 404, 발신번호 답 기록, 저장된 값 가림·다시 말하면 보임, 그다음 항목, 통화 정보 첫 질문, 마지막 확인 진행 상태 400자 안.
- 실제 통화 2건(판별 29번): 판별 모델 0.78~2.55초(중앙값 1.21초), 말 끝→진행 상태 1.38~3.15초(중앙값 1.81초 = 모델 + `pause_ms` 0.6초).
  - 28번이 `collecting`(선택지 없음, 용건만 봄)에서 `none`. 고객이 말할 때마다 판별 호출 비용만 듦.
  - 단계를 넘기는 판별은 접수 실패(`/internal/ai/orders` 404)로 측정 못 함.
- PBX 종료 웹훅 뒤 hangup 404(세션 이미 끝남), `context_injection_incomplete`로 바로 끊긴 통화 1건.
- 가짜 백엔드 브랜치에서 사용자가 정상 동작을 확인했다고 알림.
- 관제 화면은 밖으로 열려 있지 않다(Nginx는 웹훅 경로만). 보려면 SSH 터널: `ssh -i <pem> -N -L 8000:127.0.0.1:8000 ubuntu@13.209.59.180` 후 `http://localhost:8000/monitor`(`.env`의 `MONITOR_USER`·`MONITOR_PASSWORD`).
- 병합·배포: `chore/listener-latency`(`2b111f6`), `feat/poc-speech-handoff`(가짜 백엔드·상담원 연결·무응답 종료·PoC 발화, `cacc32f`), `feat/S15P31D109-14-address-correction`(`a056a36`) 모두 `develop-ai`에 병합돼 자동 배포됨. 지금 서버 릴리스는 `a056a36123c8-19`(healthy, 가짜 백엔드 경고·"주소 보정 켜짐" 로그 확인).

### 남은 것
- 가짜 백엔드로 확인·저장·추가 주문 단계의 판별 지연 측정. 이후 판별 reasoning(`none`·`minimal`)·더 작은 모델·`pause_ms`(600 → 400) 조정, `collecting`의 불필요한 판별 줄이기.
- 백엔드 DB 연동되면 `mock = false`.
- `refer_target_uri`가 아직 자리표시자(`sip:agent@example.com`). PBX 담당자에게 상담원 SIP 주소를 받아야 실제 전환이 된다. 그 전에는 전환 실패 안내 후 끊긴다.
- `help` 판별이 답할 수 있는 질문(요금·방문 시간 등)까지 상담원 제안으로 보내는지 실제 통화로 확인.
- 무응답 60초가 적당한지(고객이 물건을 찾으러 가는 등) 실제 통화로 확인.
- 새 발화로 실제 통화 비교: 통화 시간·질문 수, 되읽기가 사라졌는지, 상세주소를 따로 묻지 않는지(백엔드 모델이 ""를 넣는지), 첫 인사가 첫 질문과 맞는지.
- 확인 단계에서 "아니요"만 하고 고칠 곳을 말하지 않을 때의 진행 상태 변형 문구(지금은 `voice.md`의 "어느 부분을 고쳐 드릴까요?" 규칙뿐).
- 종료 용건(`end`)을 잘못 판별하면 접수 전이어도 확인 없이 끊긴다. 접수 전에는 한 번 확인하는 단계 검토.

### RAG 전화 통합 브랜치 준비 — S15P31D109-122

요청: 최신 develop-ai 위에서 검증한 RAG를 실제 수신 통화에 연결하고, 실험 잔여 코드를 정리한 뒤 커밋/병합 검토를 준비한다. develop-ai에 직접 병합·푸시·배포하지 않는다.

- 최신 origin/develop-ai `2b111f6`로 로컬 develop-ai를 fast-forward하고 `feature/S15P31D109-122-rag-call-integration`을 만들었다. 마무리 fetch에서도 원격은 같았다.
- 기존 feature/S15P31D109-122-rag-llm-context HEAD b9fbb9e와 미커밋 작업은 stash3c3cb3b 및 private ZIP에 보존했다. 기존 stash2개도 유지했다. stash를 새 develop에 통째로 덮지 않고 필요한 파일만 선택했다.
- 팀원 변경(LangGraph/Studio, services/webhooks 분리, PBX 종료 인증, 판별 지연, 자동 배포)을 확인·유지했다. RAG가 없던 운영 브랜치에 검색/분할/임베딩만 LangChain으로 추가하고 LLM은 SDK를 유지했다.
- 운영 RAG: 통합 Q+A large3072 Cosine, Kiwi/BM25+vector 0.4/0.6 가중 RRF c60 Top5, 고정 Qwen3-Reranker-0.6B 원문A/FP16/1024토큰, 원문 Top3. 알고리즘은 app/rag에 두고 운영 코드의 scripts 의존을 제거했다. PDF/HTML/질문 전용/C/BGE 비교·모델 가중치는 통합 대상에서 제외했다.
- Live 기본을 client 위임으로 변경했다. 최근 전사+현재 상태를 SDK backend에 보내 도구를 한 번 선택하고 기존 디스패처로 실행한다. 반환 근거는 다시 backend 답변 생성에 보내지 않고 Live thinking 조각+ACK+commentary로 직접 전달한다. 기존 responses 경로는 복귀용으로 유지하며 그 경우 function_call_output/response.create 규칙도 유지한다.
- 검색은 주문 상태/상담원 연결을 바꾸지 않는다. 중복 위임 방지, 새 위임의 옛 검색 취소, 늦은 결과 차단, 이미 시작한 쓰기의 재실행 방지, 통화별 ACK/정리, 검색/전달 실패 후 안내를 추가했다. 단계별 도구 권한·발신번호·확인 안전장치는 유지했다.
- backend 선택/검색·임베딩·DB·리랭킹·맥락 전달 시간을 남긴다. 근거 뒤 첫 패킷/전사도 관측하되 정답 안내 시작/고객 재생 완료로 부르지 않는다.
- 사용자가 GPU를 직접 준비하기로 했으므로 외부 /rerank 코드·인증·모델 버전/ID/점수 검증을 준비했다. RunPod과 Google Cloud 모두 같은 계약이다. 전화 이미지에는 torch를 넣지 않는다. 실제 외부 GPU는 미연결이다.
- 사용자 추가 결정: 3,500원 고정 요금 삭제. 미확정 fare 전송과 확정 안내도 제거했다. 백엔드는 우선 유인 기준 서류3,850/소박스4,950/중박스6,050/대박스7,150원을 계산한다. 현재 AI 주문에는 별도 규격이 없으므로 규격 입력/전달과 backend fare 생략 수용·확정 금액 응답 계약을 맞춰야 한다. 임의 금액이나 가격 API를 만들어 대신하지 않았다.
- 공개 원문 manuals/, 평가 데이터 evaluation/datasets/, 과거 집계·실제 Live 전사95개·근거·점수 evaluation/results/를 공유한다. 대용량 원시 실행/오디오/모델/비밀은 data/private에 보존하고 Docker context에서도 제외했다.
- 기존 평가: Live RRF Recall5=95/95, Qwen Recall3=95/95, Hit1=92/95, MRR0.982456. Faithfulness0.857882, ContextPrecision0.989474, ContextRecall0.989474, Factual F1=0.721368. Relevancy0.482527은 보조 기록으로 둔다. 기준 답변 자체의 Relevancy도 평균0.521229이고0.8기준8/95만 통과해 보편적 합격선으로 쓰지 않았다. 의미/한계/오답 사례·지연 범위는 evaluation/results/analysis.md에 정리했다.
- Windows CRLF와 manifest의 LF 해시가 달랐던 재현 문제를 발견했다. 과거 cases 바이트/점수를 보존하고 raw/내용 해시를 구분했다. 새 생성은 LF 바이트로 고정하고 .gitattributes로 공유 원문/평가 바이트를 보존한다.
- 검증: 전체191 passed(7.46초), compileall, FAQ32개 dry-run, 평가95문항/근거/해시 검사 성공. Docker Linux/Python3.14 이미지 빌드 성공. --network none 실행으로 SDK 세션 구성, Kiwi, 캐시 토크나이저, FAQ32개, torch/scripts/data 부재를 확인했다. Docker credential 도우미 PATH 누락은 실행 프로세스 PATH만 보완해 해결했다.
- docs/rag-handoff.md, spec/rag.md 및 관련spec, work.md, AGENTS 팀 규칙을 갱신했다. 기존95문항은 이전 실험이며 이번 통합/외부 GPU/실제 전화 평가를 새로 한 것이 아니다. .env는 읽거나 고치지 않았다.

남은 운영 확인: 외부 GPU URL/키와 서버 용량·왕복 지연, 배포 서버 Qdrant의 원문 동일 색인, 규격/요금 백엔드 계약, 실제 전화 FAQ 끼어들기/정정/취소 상태/상담원 동의/장애 회귀. develop-ai 병합 시 자동 배포가 가능하므로 완료를 확인한 뒤 반영한다.

### 2026-10-27 GCP 원격 리랭커와 develop-ai 연결 범위 확인

- GCP L4에 Qwen3-Reranker-0.6B 고정 버전의 HTTPS /rerank API를 구축하고, 로컬 실제 RAG에서 Top5 요청 → 점수 검증 → Top3 반환을 확인했다. 전화 서버에 GPU 모델을 설치하지 않고 REST로 호출한다.
- GPU 단독 준비 후 5회 평균 약 0.069초. 같은 RAG 서비스에서 시험한 3개 질문의 검색 전체 시간은 약 1.329/0.471/0.366초였다. 소수 연결 시험이며 전체 평가나 실제 통화 지연 수치가 아니다. 초기 임베딩 연결은 더 오래 걸렸다.
- VM 자동 중지/재시작을 시험했다. 재시작 후 모델 준비까지 관측 약 56초. 최종 상태 TERMINATED, 시작마다 최대 실행 시간 900초 후 STOP 설정을 확인했다. 중지 후에도 디스크·예약 IP 등 잔여 비용은 발생할 수 있다.
- 사용자는 운영 서버에 모델을 올리는 것이 아니라 기존 RAG가 REST 호출하도록 연결하려는 의도라고 정정했다. 운영 서버 접속·수정 없이 우선 저장소를 확인한다. PEM 파일은 사용하거나 읽지 않았다.
- origin/develop-ai를 fetch한 결과 2b111f6 → cacc32f로 갱신됐다. 최신 원격 코드에는 app/rag 및 search_manual, 원격 리랭커 호출 구현이 없다. Qdrant 컨테이너 설정만 있다. 실제 배포 버전은 원격 서버를 조회하지 않아 확정하지 않는다.
- 원격 호출 구현은 현재 통합 작업 브랜치의 app/rag/remote.py와 service.py에 있고, compose에는 RAG_RERANKER_URL/API_KEY 전달이 준비돼 있다. URL/키 설정만으로 현재 develop-ai에 연결되지는 않는다. 최신 팀원 변경과 RAG 통합 코드를 합친 후 배포해야 한다. 이번 확인에서 병합·커밋·푸시·운영 배포는 하지 않았다.

### 2026-10-27 최신 develop-ai와 GCP REST RAG 통합 검증

- 별도 feature/S15P31D109-122-rag-gcp-integration 브랜치를 만들고 GCP 미커밋 작업은 이름 있는 stash로 보존한 뒤 복원했다. 기존 브랜치와 stash를 삭제하지 않았다.
- origin/develop-ai cacc32f를 작업 브랜치에 통합했다. call/sideband/webhook/flow·voice 프롬프트/server-config 문서의 충돌을 해결했다. 팀원이 추가한 mock 백엔드, 첫 질문·저장된 값 가림, 상담원 연결 실패 안내, 무응답 종료를 유지했다.
- 통화 종료 시 기존 RAG/ACK 정리와 새 종료·무응답 감시 작업 정리를 함께 유지했다. 고객 전사는 input_ready 신호와 마지막 발화 시각을 모두 갱신한다. 최초 인사는 engine.next_text와 client 위임/RAG 설정을 함께 준비한다.
- 최신 팀원 프롬프트에 있던 고정 3,500원 예시와 fare 자리표시자는 재도입하지 않았다. 요금은 백엔드 확정 전 추정하지 않는다. help 의도 설명에서 단순 FAQ를 제외해 정책 질문이 상담원 연결로 오해되지 않도록 했다. 다른 단계에서 주문 도구가 없더라도 허용된 search_manual은 사용할 수 있게 지침을 맞췄다.
- 최초 전체 테스트에서 최신 확인 문구에 필요한 '이대로 접수'가 빠져 1개 실패했다. 테스트를 약하게 바꾸지 않고 고객 확인 질문을 실제 문구에 복원했다. 최종 203 passed (9.42초).
- Linux Docker 이미지 dva-ai:rag-gcp-integration 빌드 성공. 네트워크 없는 컨테이너에서 단계·프롬프트 정의, client 위임, torch/private data/deploy 파일 제외를 확인했다. 첫 점검 명령의 build_session 필수 인수 누락은 점검 호출을 보완하여 통과했다.
- 실제 운영 배포, develop-ai 최종 병합, 푸시, 새로운 유료 전체 평가/전화는 하지 않았다. GPU는 중지 상태이며 운영 비밀값 주입과 서버 Qdrant 동일 색인, 백엔드 규격·금액 계약, 실제 전화 검증이 남아 있다.

### 2026-10-27 운영 SSH 및 RAG 준비 상태 실측

- 사용자가 기존 PEM이 다른 서버용이라고 정정하고 바탕화면 dva-monolith.pem으로 교체했다. 기존 실패 원인은 파일 권한만이 아니라 인증 키 불일치였다. 교체 키를 현재 사용자 전용 ACL로 설정한 뒤 ubuntu@13.209.59.180 SSH 접속에 성공했다. 개인키는 출력하지 않았다.
- 실행 AI 이미지 dva-ai-server:a056a36123c8-19 및 Qdrant1.13.4가 실행 중이다. 운영 이미지에 app/rag/service.py가 없고 RAG_RERANKER_URL/API_KEY와 QDRANT_API_KEY가 AI 실행 환경에 설정되지 않은 것을 값 출력 없이 확인했다.
- AI 컨테이너 자격 없이 Qdrant 조회는 HTTP 오류였다. 이어서 Qdrant 컨테이너의 실행 인증값을 메모리에서만 사용한 읽기 전용 조회로 컬렉션 0개를 확인했다. 운영 DB에는 아직 FAQ 색인이 없다.
- .env/비밀값 출력·수정, DB 등록/삭제, 서버 재시작, 운영 배포는 하지 않았다. 실제 운영 연결에는 통합 코드 배포, 실행 환경 설정, FAQ 최초 색인이 모두 필요하다. GCP 단독 연결 성공과 운영 RAG 준비 완료를 구분한다.

## 2026-10-27 (주소 보정, S15P31D109-14)

### 바꾼 것
- `kakao_map_test`의 주소 보정 모듈을 `app/address/`로 옮김(`corrector.py`·`db.py`·`stt_preprocess.py`). 로직은 그대로, 서버에서 안 쓰는 CSV 로더·카카오 검색·자체 테스트만 뺌. 주소DB는 읽기 전용으로 열고, 조회는 잠금+스레드(`app/address/__init__.py`).
- 처음에는 `record_order` 안에서 보정했다(`correct_addresses`, 뒤에 아래 address 단계로 옮김). 고객에게 다시 묻지 않고 서버가 정함: 확정이면 그 주소, 애매하면 가장 가까운 후보, 못 찾으면 들은 그대로. 주소 질문은 바꾸지 않음(사용자 결정).
  - 중간에 애매함·못 찾음이면 후보를 읽어 고르게 하거나 "시·구부터" 다시 묻는 방식과 주소 질문 변경("시·구부터 말씀해 주시겠어요?")을 넣었다가, 사용자 결정으로 모두 되돌림.
  - DB 위치를 `app/address/db/`로 옮겼다가(코드 `db.py`와 이름이 겹쳐 `database.py`로 바꾸기까지 함) 사용자 결정으로 `data/`로 원복.
- 설정 `[address] db_path = "data/address.db"`. 파일이 없으면 보정 끔. 이미지·git에 넣지 않고 볼륨(`ADDRESS_DATA_DIR`, 배포 서버 `shared/data`). `.dockerignore`에 `data` 추가(빌드 컨텍스트에 수백 MB가 들어가지 않게).
- 발화: 마지막 확인에서 도로명·건물번호를 읽기(보정으로 바뀐 도로를 고객이 듣게). 백엔드: 기본주소에 시·도·시·군·구를 빼지 않기, 바로잡힌 주소를 다시 고치지 않기.
- `spec/address.md` 추가.
- 빠진 지역 단계 보정(`app/address/corrector.py` `match_region`·`below_sido`, 이 저장소에서 직접): 시도를 빼고 말하면 모든 시도에서 시·군·구부터(이름은 정확히 들렸을 때만), 구를 빼면 그 시의 구 전부에서 찾는다. 포항시·고양시 시 단독 예외 행은 그 시의 구와 함께.
- 주소 확정을 LangGraph 단계로 분리(`app/flow/stages/address.py`, 사용자 결정): `record_order`는 새 주소를 확정할 주소로 표시만 하고, `collecting`·`confirming`의 `order.updated`에서 `address` 단계로 들어가 주소DB로 정한 뒤 바로 돌아간다(하위 흐름, 고객에게 묻지 않음). 주소별 결과(확정·1등으로 정함·못 찾음·보정 꺼짐, 바뀌었는지)를 관제 화면·스냅숏에 표시.
  - 엔진: `on_enter`가 async여도 되게(`_move`를 async로).
  - 고치다 찾은 문제: 하위 흐름에서 돌아오면 돌아간 단계에는 원래 사건이 아니라 ENTERED가 다시 들어간다. `confirming`에는 ENTERED 조건이 없어서, 마지막 확인에서 주소만 바꿔 상세주소가 빠져도 `collecting`으로 돌아가지 않았다. `confirming`에 `ENTERED → collecting(빠진 항목 있음)` 추가.
- 원본의 연음 규칙(kakao_map_test, "인의동"을 "이니동"으로 받아써도 같은 소리로 비교: 연음, 첫 음절 아닌 ㅢ→ㅣ)을 다시 옮김. 바뀐 것은 `jamo()`뿐이고 이 저장소의 빠진 지역 단계 보정은 그 위에 다시 얹음.
- 주소DB 갱신(kakao_map_test, 지번 검색 추가): 법정동·리·지번 표가 생겨 DB가 약 300MB → 600MB. `corrector.py`·`db.py`를 같은 방식으로 다시 옮김(바뀐 것은 지번 검색뿐, `numbers()`가 목록을 돌려주게 바뀜). 테스트용 작은 DB에 지번 표·사례 추가.

### 확인한 것
- 빠진 지역 단계: 벤치(시드 31, 1만 건, 지역부터 말함)에서 전후 결과가 바뀐 건 1건(애매 정답 없음 → 정답 있음), 나머지 동일. 오류 없는 실제 주소로 시도 생략 600건 정답 99.7%·오답 0, 구 생략 193건 정답 99.5%·오답 0.
- 연음: "경북 구미시 이니동 844-5", "구미시 이니동 844-5"(시도 생략까지) → "경상북도 구미시 인동9길 7-3".
- 주소 확정 단계: 시나리오 9개의 단계 경로에 `address`가 들어감(Studio 그래프도 같은 경로). 마지막 확인에서 주소만 바꾸면 address → confirming → collecting.
- `uv run pytest -q` 183개 통과(보정기 사례 37개·지역 트리, 작은 주소DB로 확정/애매함/없음, record_order 확정·애매함은 1등·못 찾음은 들은 그대로·DB 없음, 테스트는 개발 PC의 실제 DB와 무관하게 보정 끔).
- 실제 주소DB(`ai/data/address.db`, kakao_map_test에서 복사): 로딩 0.04초, 도로명 한 건 2~10ms, 지번 120~320ms. 기동 시 "주소 보정 켜짐" 확인. "경북 구미시 인의동 844-5"를 record_order로 넣으면 "경상북도 구미시 인동9길 7-3"으로 기록.
  - "부산 해운대구 센텀로 10"이 "센텀2로 10"으로 확정됨(다른 도로로 바로잡힘). 마지막 확인에서 도로명을 읽게 한 이유.

- Docker 이미지에 주소DB가 들어가지 않는 것: 이미지를 직접 빌드해 확인(111MB, 이미지 안에 `address.db` 없음). 같은 이미지에 `data/`를 볼륨으로 붙이면 보정이 켜짐.
- 배포 서버에 주소DB 올림: `/home/ubuntu/dva-ai/shared/data/address.db`(612MB). 임시 이름으로 올려 SHA-256이 같은 것을 확인한 뒤 이름 바꿈, 서버에서 `PRAGMA quick_check` ok(도로 372,256·건물 6,424,995·지번 8,195,538), 파일 644·폴더 755. 병합 후 자동 배포된 릴리스 `a056a36123c8-19`에서 `/home/ubuntu/dva-ai/shared/data -> /app/data` 볼륨과 "주소 보정 켜짐: /app/data/address.db" 로그 확인.

### 남은 것
- 실제 통화로 확인: 백엔드 모델이 시·구를 빼지 않고 넘기는지, 오답(다른 도로·다른 번호로 정해짐) 빈도.
- `modify_order` 주소 보정, 아파트 이름으로 말한 주소. 지번 보정 오류 벤치.
- 빠진 지역 단계 보정을 kakao_map_test 원본에도 반영(지금은 이 저장소에만 있음). 원본을 다시 가져올 때 `match_region`·`below_sido`·`GU_SKIP`을 다시 얹어야 한다.

## 2026-10-27 (주소 보정 모듈 `kakao_map_test`, address-stt-eval-plan 세션)

이 저장소 밖(`C:\Users\SSAFY\Desktop\kakao_map_test`)의 작업. 이 저장소의 `app/address/`는 여기서 옮겨 왔다. `git init`만 했고 커밋은 없다(`.gitignore`: `.env`·원본 주소DB 폴더·`address.db`·벤치 결과).

### 바꾼 것
- 모듈 분석: STT로 받아쓴 주소 → 지역 퍼지 매칭 → 도로명 발음 정규화 편집거리 → 행안부 주소DB(SQLite)로 건물번호 존재 확인. 카카오 API는 비교 테스트용일 뿐 보정에는 필요 없음.
- 지역부터 좁혀 찾기(사용자 전제: 고객은 지역부터 말한다): 시도 → 시군구 → 도로. 이어서 도 > 시·군 > 구 > 로 4단계 트리로(시군구명 "성남시 분당구"를 공백으로 잘라 두 단계, 군·구 생략 "금산", 시 건너뛰기 "경기 분당구", 붙여 말함 "성남시분당구").
  - 주소DB의 `포항시`·`고양시` 단독 시군구는 건물 0개인 예외 데이터(도로 3개). 동점 처리 문제의 원인.
- 테스트 케이스를 실제 STT 오류 기준으로 다시 만듦(`build_cases.py`): 기존 케이스는 보정 규칙과 같은 규칙으로 만들어 정답률이 부풀려져 있었음. 이어서 입력을 live-1이 정리한 `record_order` 주소 문자열로 보고 오류 가중치를 다시 맞춤.
- 숫자를 읽는 소리로 비교(길 번호·건물번호, "일"/"이"), 후보 도로의 실제 건물번호 전부와 거리를 더해 고르기, 결과 세 가지(`correct()`: 확정·애매함(후보 최대 3)·없음). 건물번호를 고쳐 맞춘 주소는 확정하지 않음.
- 지번 주소 검색: 주소DB 빌드에 법정동·리(`areas`)·지번(`jibun`) 표 추가(지번 819만 건 모두 건물과 연결, DB 297MB → 607MB, 빌드 약 70초). 시군구 안의 법정동·리 이름을 소리로 비교하고 결과는 그 지번 건물의 도로명주소. `844-5`·`844번지 5호`·`산 12`·`선산읍 완전리`·행정동 `역삼1동` 처리, 한자로만 구분되는 리 6개는 괄호를 떼고 비교. 지번→도로 조인 인덱스(`roads_key`)가 빠져 매우 느렸던 것을 추가해 한 건 10~340ms.
- 발음 비교에 연음·ㅢ 규칙: "인의동"을 STT가 "이니동"으로 받아써 못 찾던 문제(사용자 실제 시험). `이니동`↔`인의동` 거리 2.6 → 0.6.

### 확인한 것
- 기존 테스트(카카오 300건 98%, 2천 건 100%)는 튜닝에 쓴 데이터라 믿기 어려움. 실제 STT 오류로 다시 만들자 2만 건 정답 99.95% → 65.4%, live-1 가중치로 73.1%(못 찾음 23.4%·오답 3.5%).
- 4단계 트리: 정답 73.1% → 74.6%(튜닝에 안 쓴 시드 31에서 75.2%), 시·군 생략 51% → 84%.
- 숫자 소리 거리 + 세 가지 결과: 시드 23에서 확정 정답 72.7%·확정 오답 3.0%·애매함(정답 포함) 7.5%·못 찾음 13.4%. 확정 오답은 대부분 숫자를 잘못 들었거나 다른 실제 도로로 들은 경우라 보정으로는 막지 못함.
- 주소DB로 1↔2 혼동 확인: 길 번호를 바꿔도 실제로 있는 경우 7%, 건물번호 21%. 나머지는 DB로 가려낼 수 있다.
- 지번: 오류 없는 2,000건에서 정답 86.0%·애매함(정답 포함) 14.0%·오답 0(애매함은 한 지번 위 건물 여러 채). 도로명 벤치 2만 건은 지번 검색 전후 결과가 바뀐 건 0.
- 테스트 방법론 점검: 오류 생성기와 보정 규칙이 같은 사람이 만든 규칙이라, 로직 전후 비교에는 쓸 수 있어도 실제 통화 정확도 추정은 아니다.
- 실수: 확인용으로 `build_cases.py`를 실행해 카카오 API가 호출됐고 `cases_generated.json`·`roads_kakao.csv`가 백업 없이 덮어써짐(같은 생성기로 다시 만들어진 것이라 쓰는 데 지장은 없음).

### 남은 것
- 실제 정확도 평가: 팀원이 직접 걸기 어려워서 TTS로 고객 음성을 만들어 같은 GPT-Live 설정(WebSocket)에 넣고 `record_order` 주소 인수를 모으는 평가셋을 제안함(사용자 답 대기). WebSocket 세션에서 위임·함수 호출이 되는지부터 확인 필요. 실제 통화의 (말한 주소, 모델 입력) 쌍도 틈틈이 모으기.
- 지번 오류 벤치, 아파트 이름(`부가정보` 파일), 부번을 빼고 말한 경우("인동9길 7"은 7번 건물로 확정됨)는 대화 흐름 쪽에서 다뤄야 함.
- 커밋.

## 2026-10-27 (기타)

- 로컬에서 시험 페이지를 80·443(자체 서명 인증서)으로 띄워 봄. 웹훅 포트 정리: OpenAI 웹훅은 등록한 URL의 포트(포트 없는 `https://`면 443) 인바운드가 필요하고, 로컬 FastAPI(8080)에서 받으려면 `ngrok http 8080`으로 터널(공인 인증서는 ngrok이 제공). 이 저장소 변경 없음.



### develop-ai 병합 준비 최종 검증 — 주소 보정 포함

사용자의 develop-ai 병합 요청에 따라 원격을 다시 가져왔고, 최신 a056a36의 주소 보정 기능까지 작업 브랜치에 합쳤다. address 단계·주소DB 읽기 전용 볼륨·최종 도로명 확인을 유지하면서 RAG/client 위임 설정과 함께 충돌을 해결했다. 고정3500원 안내는 재도입하지 않았다. 전체 가짜 테스트254개 통과(10.79초), Linux Docker 빌드 및 네트워크 차단 기동 정의 검증 통과. 운영 활성 통화 수0개를 확인했으며 개인 통화 내용은 출력하지 않았다. 팀 규칙대로 작업 브랜치→develop-ai MR로 반영하고 자동 배포 결과와 RAG 운영 준비를 구분한다. 운영 RAG 비밀값/색인은 아직 미설정·0컬렉션 상태다.

## 2026-10-28 (백엔드 연동 계약 반영, S15P31D109-132)

### 바꾼 것
- 백엔드 새 계약(`develop-backend`의 `docs/api/`)에 맞춤. 원문 `spec/orders.md`·`spec/ai-pbx-recordings.md`를 추가했고, `spec/backend-api.md`는 AI가 그 계약을 어떻게 쓰는지로 다시 씀.
  - 고객 확인 `POST /api/customers/context`: 등록·미등록·탈퇴 구분, 주소록(PIN)은 출발지·도착지 후보 모두로 씀. 탈퇴 고객은 바로 상담원 연결.
  - 통화 결과 `POST /api/orders`를 **통화당 한 번**(백엔드는 통화 한 건에 주문 한 건). 택배는 `parcels`로 묶음. 키는 통화마다 UUID 하나, 재확인에도 같은 키·같은 본문을 씀. `ACCEPTED`일 때만 접수 완료로 안내. 처리 중(연결 실패·504·202·409 처리 중)은 같은 키로 다시 확인함.
  - `incomingAt`은 수신 웹훅 `created_at`(SDK 타입 `LiveTransportIncomingWebhookEvent.created_at: int` 확인)으로 만듦.
- 흐름(`spec/scenario.md`)
  - 택배를 확인하면 담고(`confirming` → `after_order`), "더 없어요"에서 한 번에 접수.
  - 수거 희망 시각·결제 방식·전화 주신 분 성함(미등록이고 보내는 분 번호 ≠ 발신번호일 때만)은 첫 택배를 확인하기 전에 받음. 그래야 끊겨도 확인한 택배를 COMPLETE로 보낼 수 있다.
  - 물품은 규격별 수량(서류·소형·중형·대형) 또는 기타 물품, 물품 가액도 받음.
  - 통화가 끝날 때(`Call.finish`): 상담원 연결은 INCOMPLETE(확인한 택배 + 받는 중이던 택배), 고객이 그만두면 CANCELLED, 끊김·무응답은 확인한 택배를 COMPLETE로.
  - `submitted`·`save_offer` 단계 삭제(배송지 저장 API 없음). 조회·수정·취소 단계는 `HELD`로 옮겨 흐름에서 뺌(도구·테스트는 남김). 그 용건은 상담원 연결 제안으로 감.
- 주소: 확정한 주소로 카카오 주소 검색을 해 지번·동명·우편번호·좌표를 채움(`app/address/kakao.py`, 키 `KAKAO_REST_API_KEY`). 못 찾으면 임의 값을 넣지 않고 그 통화는 INCOMPLETE로 보냄.
- 설정: `[backend] submit_timeout_sec`·`submit_retry_sec`·`retry_interval_sec`, `[address] kakao_timeout_sec`. `.env.example`·`compose.yaml`에 카카오 키.
- 프롬프트(`voice.md`·`backend.md`·`flow.toml`), 관제 화면(담은 택배·통화 결과), Studio(고객 상황 `new`·`saved`·`withdrawn`)를 같이 고침.

### 확인한 것
- 백엔드 코드(`develop-backend` 3b76406)
  - 이미 주문이 연결된 통화에 새 키로 보내면 409.
  - 디버 접수는 order 단위로 한 번이고, 결과(`status`·`parcelNo`)와 결제 방식·수거 시각도 order에 하나.
  - COMPLETE는 주소 9개 항목·우편번호 5자리·수량 또는 기타 설명·`itemPrice`·미래 수거 시각이 없으면 422.
- 배포 서버 Swagger(`https://13.209.59.180/api/docs-json`): 스키마가 코드와 같음. 조회·이전 주소 API는 AI에게 `call_session_seq` 헤더를 요구하는데, 이 값은 `POST /api/orders` 응답으로만 받으므로 통화 중에는 쓸 수 없다(조회·수정·취소 보류의 근거).
- 카카오 "주소로 좌표 변환" 응답 필드를 공식 문서로 확인함(`x`·`y`는 문자열, 우편번호 `road_address.zone_no`).
- 테스트: `uv run pytest -q` 287개 통과(가짜 백엔드·가짜 HTTP·가짜 카카오).

### 남은 것
- 실제 백엔드·카카오·통화로는 확인하지 않음(사용자 확인 필요): `KAKAO_REST_API_KEY` 설정, `[backend] mock = false` 전환.
- "더 없어요" 뒤 접수 응답을 기다리는 동안(디버 최대 10초 + 재확인) 고객은 대기한다. 실제 통화에서 체감 시간을 확인해야 함.
- 결제 방식 선택지 규칙(개인카드 = 미등록 또는 PERSONAL)은 백엔드 설명에서 추정했고, 최종 판정은 백엔드가 한다(403이면 "확인 후 연락" 안내).
- 관제 화면의 주문 목록은 실제 백엔드에서는 관리자 세션이 필요해 비어 있음.

### 추가 정리
- AGENTS.md: 문서 표·비밀값(`KAKAO_REST_API_KEY`)·저장·안전장치(택배 담기, 통화당 접수, `ACCEPTED`만 성공)·아직 없는 것(조회·수정·취소 보류)을 새 계약에 맞춤.
- `work.md`: 백엔드 연동 현황 표 추가.

### 실제 통화 판별 시간 초과(13:19~13:21)
- 증상: 컨테이너 로그에 "판별 실패 …:"가 빈 메시지로 17번(`TimeoutError`, `[listener] timeout_sec = 5`). 성공한 판별도 모델 4.6~5.0초(지난 실통화 중앙값 1.2초). 판별이 안 되어 통화가 `collecting`에 머물다 고객이 끊음 → INCOMPLETE.
- 확인: 이번 변경으로 판별 입력은 의도 한 줄(`quit`)만 늘었다. 13:23에 컨테이너 안에서 같은 형태(지시문·선택지·스키마)로 재면 `gpt-6-luna` low 0.9~1.5초로 정상 → 그 시간대 OpenAI 응답 지연으로 보이나 확정은 못 함. 13:18 accept 503은 가짜 세션 id(`live_u0_abc123`) 시험 웹훅이라 무관.
- 바꾼 것: 판별 실패 로그에 오류 이름과 걸린 시간을 남김(`app/listener.py`).
- 남은 것: 컨테이너 다시 빌드 후 실제 통화로 재확인. 계속 느리면 `reasoning_effort = "none"`이나 더 작은 모델 검토.

### 도구 미실행(13:26 통화) → 위임 방식 되돌림
- 증상: 2분 통화에서 고객 말 12번 동안 위임 0건·도구 0건, 임시 주문이 끝까지 비어 있음. 음성 모델이 혼자 질문을 이어 가 마지막 확인까지 말함(결제 방식 "알림톡"도 지어냄). 서버 기록이 없어 INCOMPLETE.
- 원인 범위: `config/live.toml` `[delegation] type`이 10-27 RAG 통합(`dee3f66`)에서 `responses` → `client`로 바뀌었다. client는 실제 통화로 확인된 적이 없다. OpenAI가 `session.delegation.created`를 안 보냈는지, 보냈는데 `target`이 달라 버렸는지는 로그가 없어 모름.
- 바꾼 것: 운영 설정을 `responses`로 되돌림(`search_manual`은 responses에서도 백엔드 모델 도구로 쓰임). sideband 이벤트 종류를 통화마다 처음 한 번 INFO 로그, client가 아닌 위임은 `위임 무시` 경고. 테스트는 responses 기본·client 구성 유효로 고침(287개 통과). AGENTS.md·`spec/gpt-live-session.md`·`spec/sideband.md`·`spec/tools.md`·`docs/rag-handoff.md`에 보류 표시.
- 남은 것: responses로 실제 통화 확인. RAG 담당자에게 client 미동작 전달, 새 로그로 원인 확인 뒤 복귀 판단.

### 로컬 Qdrant에 매뉴얼 색인 복원
- 배포 서버(13.209.59.180) Qdrant에 `manuals_dev_openai_large`(32개, green)가 있음을 읽기 전용으로 확인(10-27엔 0개였음). 서버에서 스냅숏을 만들어 내려받은 뒤 서버 쪽 스냅숏·임시 파일은 지움. SHA-256 일치(`09d6c6fd…`).
- 로컬 `dva-ai-qdrant-1`에 `file://` 위치로 복원 → 32개 green. AI 컨테이너 재시작 후 "RAG 준비 미완료" 경고 사라짐. 인증키는 컨테이너 안에서만 썼다.
- 남은 것: 실제 검색(임베딩·리랭커 GPU) 경로는 확인 안 함. 서버 docker는 `sudo`가 필요함.

### 페르소나 연동 준비(백엔드 94·98 병합 대기)
- `spec/ai-persona-integration.md`(백엔드 전달 문서) 확인. 백엔드 페르소나 API는 아직 원격에 없음(develop-backend 병합 중) → `GET /api/ai/config`의 `data` 필드는 미확인.
- 지원 옵션 판단: 음성은 내장 31개 중 선택, 말 속도는 GPT-Live 설정에 없어 `{min:null,max:null}`, 말끝 대기는 모델이 정해 `["NORMAL"]`만. `[listener] pause_ms`(서버 판별 대기)를 말끝 대기로 쓰지 않는다.
- 사용자 결정: 관리자가 고치는 프롬프트는 말투·인사 부분만(업무 규칙은 고정). AI 쪽 DB는 두지 않고 백엔드 페르소나 설정(PENDING→ACTIVE)을 쓴다.
- 바꾼 것: `prompts/voice.md`에서 말투·인사 문구를 `prompts/persona.md`로 빼고 `[[페르소나]]` 자리를 둠. `build_session(persona=...)`이 그 자리를 채운다(없으면 persona.md). 테스트 288개 통과.
- 남은 것: 백엔드 병합 후 응답 필드 확인 → `/internal/persona/options`·`refresh`(Bearer `AI_PERSONA_TOKEN`), 적용 작업(통화 0건에 잠금·설치·apply-result·ACTIVE 확인), 통화별 설정 고정, 연동 확인 시나리오 테스트. 관리자에게 보일 음성 목록과 설정이 없을 때 통화 처리(로컬 기본값 권장)는 결정 대기.

### 페르소나 연동 구현(백엔드 develop-backend 295b123 병합 확인)
- 확인한 것: 백엔드 `backend/src/ai-settings/`(응답 `{data, meta}`, 필드 `aiPersonaVersionSeq`·`applicationId`·`promptText`·`voiceId`·`speakingRate`·`turnWaitLevel`·`status`·`applyErrorCode`), 알림은 5초마다 확인·30초 간격 재시도·응답 제한 2초·202 필요, APPLIED는 통화 0건만, 교체·불일치는 409, DB에 기본 페르소나 없음. 관리자가 페르소나를 만들 때 백엔드가 AI `/internal/persona/options`로 검증하므로 이 API가 있어야 관리 화면이 동작한다. 연동 문서는 로컬 사본과 같음.
- 바꾼 것: `app/persona.py`(옵션: 음성 31개·속도 null·말끝 NORMAL, 검증, 통화 0건에서 잠그고 적용·회신·ACTIVE 확인, 409·회신 유실 재동기화), `app/webhooks/persona.py`(`/internal/persona/options`·`refresh`, Bearer `AI_PERSONA_TOKEN`), 웹훅에서 잠금 중 reject·통화별 설정(지시문·음성) 고정(`Call.persona_version`), `BackendAPI.persona_config/persona_result`(토큰은 페르소나 API에만), 가짜 백엔드 흉내, `build_session(voice=)`, 설정 `[persona]`, compose·.env.example에 `AI_PERSONA_TOKEN`. 문서 `spec/persona.md` 새로, AGENTS.md·`spec/server-config.md`.
- 테스트 302개 통과(페르소나 12개, 클라이언트 2개 추가).
- 남은 것: 실제 백엔드와 연동 확인(토큰 설정 → 관리자 화면 옵션 조회 → 적용 → 통화 중 수정 대기 → 마지막 통화 후 ACTIVE). 백엔드·프론트에 "promptText는 말투·인사 부분만" 전달. 음성 표시명은 지금 영문 이름 그대로.

### 주소 보정: 도로 이름 안의 숫자(17:19 통화)
- 증상: 보내는 곳 "서울 양천구 신정이펜1로 50"이 `not_found`(카카오도 결과 없음) → 지번·좌표 없음, 고객에게 주소를 여러 번 다시 물음. 받아쓰기부터 "신정 201로", "신정2-1로"로 숫자였고 백엔드 모델이 그대로 기록. 보정기가 도로 이름 안의 숫자를 소리로 읽지 않아 발음 거리가 벌어짐.
- 바꾼 것: `app/address/corrector.py` 사전 도로명의 숫자는 값으로 읽고, 들은 도로명은 숫자 읽기 변형(값·한 자리씩·하이픈 나눔) 중 가장 가까운 것으로 비교. 실제 주소DB로 "신정 201로 50"·"영천구 신정 201로 50" → 확정, "신정 2-1로 50" → 애매함(후보 1개, 1등으로 기록). 기존 사례 영향 없음(테스트 307개 통과, 이번 사례 5개 추가). `prompts/backend.md`: 숫자로 바꾸는 것은 길 번호·건물번호·번지·호수뿐, 도로 이름 안의 소리는 한글 그대로.
- 같은 통화에서 본 다른 문제(미해결): 첫 `record_order`에 보내는 곳 주소가 빠짐(백엔드 모델 누락), "지금 전화하신 번호로 연락드릴까요?"를 진행 상태보다 먼저 물어 "네"가 판별되지 않고 같은 질문을 여러 번 반복.
- 남은 것: kakao_map_test 합성 벤치로 정답·오답률 다시 재기, 실제 통화 확인.

### 가짜 백엔드 설정을 환경변수로
- 바꾼 것: `config/server.toml` `[backend] mock` 삭제 → 환경변수 `BACKEND_MOCK`(`true`/`1`이면 가짜 백엔드, 없으면 실제 백엔드). `app/main.py`, `app/config.py`, compose.yaml(기본 false)·.env.example, `spec/server-config.md`·`spec/backend-api.md`·work.md, 테스트. 테스트 307개 통과.
- 주의: 설정 파일에 `mock = ...`가 남아 있으면 strict 설정 검증으로 기동 실패. 가짜 백엔드를 쓰던 환경은 `.env`에 `BACKEND_MOCK=true` 추가 필요.
- 이어서 고침: (1) `collecting` 선택지가 "지금 전화하신 번호로"·결제 방식 답을 바로 다음 차례일 때만 받아, 성함 기록 전에 고객이 "네"라고 하면 버려지던 것 → 항목이 비어 있으면 받음(테스트 추가). (2) `backend.md`의 "주소가 모호하면 기록하지 말라"가 "서울시 영천구"처럼 틀려 보이는 주소를 버리게 함 → 주소는 들은 그대로 기록, 한 번에 들은 주소는 모두 같은 호출에. 테스트 308개 통과.

### 시나리오 순서 점검과 수정(사용자 요청)
- 추가 택배: 신규·등록 모두 `recent_offer`에서 "보내시는 분과 보내시는 곳은 같으신가요?"만 묻는다. 예면 보내는 쪽(성함·연락처·출발지·지번·좌표)만 채우고 받는 곳부터(신규 `collecting`, 등록 `find_destination`). 전에는 등록 고객만, 보내는 곳·받는 곳을 둘 다 앞 택배로 채웠고 신규는 보내는 쪽부터 다시 물었다. 문구 변수 `recent_order` → `recent_origin`.
- 전화 주신 분 성함(미등록, 다른 보내는 분 번호): 물품 가액 뒤 → 보내는 분 연락처 바로 뒤.
- 등록 고객이 새 출발지에서 보낼 때: "보내시는 분은 ○○ 님 본인이신가요?" 한 번(`use_customer` → 성함·발신번호). 항목 문구에 고객 유형별 변형(`sender_name.registered`, `engine.field_text`)을 둠.
- 물품 질문 문구를 "소형 박스 두 개"처럼 크기·개수를 한 번에 말하게 바꿈.
- 테스트 315개 통과(시나리오 4개 갱신·추가, 단위 3개). `spec/scenario.md`, AGENTS.md "아직 없는 것", voice.md 갱신.

### 음성 모델 위임 누락 → 서버가 기록을 맡김(17:44 통화)
- 증상: 141초 통화에서 고객 말 11번 동안 위임 0건(마지막 매뉴얼 검색 1건뿐) → `record_order`·주소 보정 0건, INCOMPLETE. 13:26 통화와 같은 증상. 같은 통화의 `search_manual` 오류는 외부 리랭커(`RAG_RERANKER_URL`) 연결 시간 초과(코드 문제 아님).
- 확인한 것: 공식 문서(live-delegation "Accept typed input", sideband 참조)에 Responses 위임에서 `response.item.create`(user 메시지) 후 `response.create`로 백엔드를 돌리는 방법이 있음. 서버가 시작한 응답의 글이 음성으로 나가는지, 진행 중 응답과 겹칠 때 동작은 문서에 없음.
- 바꾼 것: `app/listener.py` `record_heard` — collecting·confirming에서 판별이 none/none이고 말이 끝난 뒤 위임이 없었으면 고객 말을 백엔드에 넘김(문구 `prompts/flow.toml` `record_heard`). `Call.delegated_at`, `spec/sideband.md`. 테스트 316개 통과(1개 추가, 가짜 conn `outputs()`는 함수 결과만).
- 남은 것: 실제 통화로 확인 — `서버 기록 요청` 로그 뒤 `record_order` 실행·주소 보정, 백엔드 글이 이상하게 말해지지 않는지, 위임과 겹쳐 두 번 기록되는지.

### 없는 주소를 주소로 받던 문제(17:55 통화, "인동 국일")
- 증상: 받는 곳 "경북 구미시 인동 국일 7-3"(실제 인동9길 7-3, "구길"이 연음으로 "국일")을 보정·카카오 모두 못 찾았는데 들은 그대로 주문에 들어감.
- 바꾼 것(사용자 결정): (1) 못 찾으면 연음 길 번호를 되돌려 한 번 더 찾음(`unlink_gil`, 처음 찾으면 거치지 않음). (2) 못 찾은 주소는 지우고 한 번 다시 물음(`*_address.retry` 문구, `Call.address_retry`, 문구 변형은 `Call.field_variants`), 두 번째는 들은 그대로(접수 미완료). 10-27에 되돌렸던 되묻기를 못 찾음에 한해 다시 넣음. (3) 약한 애매함(1등이 점수 > 3.0이고 건물번호까지 바꿔야 맞음)은 못 찾음으로("구미시 없는길 99" → 임은길 19로 바꾸지 않음). 실제 주소DB로 확인: 인동 국일 7-3·인동국일 7-3 → 확정, 없는길 99 → 못 찾음, 신정 2-1로 50·테헤란로 112 → 지금처럼 1등.
- 테스트 318개 통과. 남은 것: 합성 벤치로 확정·오답·못 찾음 비율 다시 재기(약한 애매함 기준 검증), 실제 통화.

### 응답 지연(값을 말한 뒤 10~16초)
- 측정: 18:12 통화에서 주소·물품을 말한 뒤 상담원 첫마디까지 13~16초, 그 밖의 말은 1~4초. 서버 처리(기록 0.2~0.3초, 판별 1.2~2초)는 짧고, OpenAI 쪽 백엔드 모델이 `get_state` → `record_order` → 답 순서로 2~3번 돌았다(한 번 1.3~2.8초). `backend.md`의 "모르겠으면 get_state" 때문에 매번 상태부터 조회. 낮의 client 위임 통화가 빨랐던 것은 도구가 한 번도 실행되지 않았기 때문으로 보인다.
- 바꾼 것: `backend.md` — 기록할 값이 있으면 `get_state` 없이 바로 `record_order`(어느 항목인지는 상담원의 직전 질문으로). 단순 시험에서 주소·물품은 바로 기록, 이름·시각은 여전히 조회. 추론 none은 조회가 더 잦아 이득 없음.
- 시험 중: `config/live.toml` 위임을 다시 `client`로(서버가 상태를 넣어 백엔드 모델 한 번으로 기록, 결과를 음성 모델에 직접). 새 로그(`sideband 이벤트`, `위임 무시`)로 위임이 오는지 확인한다. 이 상태에서는 기본값을 responses로 가정한 테스트 3개가 실패한다(시험 뒤 정해서 맞춤).

### client 위임 재시험 결과(2026-10-29 09:40 통화)
- 170초·고객 말 약 20번에서 위임 3건뿐(접수 시간·요금 질문 때만). 성함·주소·물품·수거 시각은 한 번도 위임하지 않아 기록 0건. 위임이 오면 처리는 정상(`위임 무시` 없음, 넘김→음성 2~3초).
- 기록이 없어 진행 상태가 "성함"에 머물러 질문 뒤 "성함부터…"로 되돌아갔고, 서버 선택지에 없는 결제 방식("현장 결제")을 지어냄.
- 결론: client 방식에서 음성 모델은 질문할 때만 위임하고 주문 정보 기록은 위임하지 않는다 → 커밋된 `responses`로 되돌림(설정 파일만, 재시작 불필요).
- 다음 후보: 서버가 고객 말마다 직접 백엔드 모델을 불러 기록(위임 없이, 판별과 같은 시점). 음성 모델의 위임 습관과 상관없이 한 번의 모델 호출로 기록된다.

### 상담원 제안이 모든 말에 반복되던 문제
- 원인: `handoff` 단계는 예·아니오·그만·새 주문만 받아 나간다. 제안에 답하지 않고 다른 말(주소 등)을 하면 판별이 none이라 그대로 머물고, 진행 상태의 "다음"이 계속 "연결해 드릴까요?"여서 고객의 모든 말에 같은 제안을 되풀이했다. 이 단계에서는 `record_order`도 막혀 말한 정보가 버려진다. 반복 실패 제안 뒤 `answer_failures`를 0으로 돌리지 않아, 거절 후 한 번 실패해도 바로 다시 제안했다.
- 바꾼 것: `listener.apply_answer` — handoff에서 answer·intent가 모두 none이면 `intent.stop`(거절로 보고 복귀). 반복 실패로 제안할 때 실패 횟수 초기화. 테스트 1개 추가(319개 통과), `spec/scenario.md`.

### 상담원이 멈춘 통화(10:37, 105초)
- 증상: 고객이 "오사카로 택배 보낼 수 있나요"라고 묻자 음성 모델이 위임 → 백엔드는 `get_state`만 부르고 답을 돌려주지 않음 → "확인해보고 안내드리겠습니다" 뒤 약 50초 대기, 이후 "가입부터 도와드릴까요?" 같은 엉뚱한 말. 기록 0건.
- 원인(추정): 서버 기록 요청(`record_heard`)이 고객 말마다 5번 나갔다. 첫 요청은 음성 모델의 위임보다 0.3초 먼저, 나머지는 위임된 백엔드 응답 진행 중에 `response.create`를 보냈다(spec에 "미확인"으로 적혀 있던 경우). FAQ처럼 주문 정보가 아닌 말도 넘겼다.
- 바꾼 것: 설정 `[listener] record_heard`(기본 false)로 끔. 코드는 유지. 켠 상태의 기존 테스트는 설정을 켜고 돌게, 꺼져 있으면 보내지 않는 테스트 추가(320개 통과). `spec/sideband.md`.

### 2026-10-30 FAQ 관리 1단계 구현: 알림 영속 접수

- feature/S15P31D109-123-faq-management에서 실제 BE 계약의 POST /internal/faqs/refresh와 AI_FAQ_TOKEN 인증을 구현했다. INSERT/DELETE1~100건, UPDATE1건, UUID/정수 범위/중복/추가 필드를 엄격히 검증한다.
- 메모리 create_task 뒤202를 보내면 재시작 시 변경을 잃으므로, SQLite WAL·synchronous=FULL·명시적 COMMIT 후202를 반환한다. 요청 본문/시간/미완료 상한은 server.toml에서 관리하며 BE2초보다 짧은1.5초로 접수를 제한한다. 잠금/디스크 오류/용량 초과는503으로 재전송을 유도한다.
- eventId와 정규화한 작업/번호 집합으로 같은 알림은202, 다른 내용의 번호 재사용은409 처리한다. 동시 재전송은 SQLite 유일 제약+쓰기 트랜잭션으로 한 번만 저장한다. 시간 초과 뒤 스레드가 커밋해도 다음 재전송을 중복으로 처리한다.
- QUEUED/PROCESSING/RETRY/APPLIED 상태 및 선행 실패를 추월하지 않는 FIFO claim을 구현했다. 활성화된 앱의 기동 시 처리 중 작업은 RETRY로 복구한다. 단일 프로세스/소비자 전제이며 여러 복제 인스턴스 동작은 지원하지 않는다.
- /app/data 읽기 전용 주소DB와 분리한 rag_state named volume 및 appuser 쓰기 권한을 준비하고 로컬 상태 파일은 Git/이미지에서 제외했다. .env는 열거나 수정하지 않았다. 비밀값 없는 .env.example만 갱신했다.
- spec/faq-sync.md, server-config 계약, AGENTS 참조와 work.md를 갱신했다. 원문 조회·청킹·증분 임베딩·Qdrant/BM25 소비자는 아직 미연결이다. 기본 receive_enabled=false로 운영 활성화를 막으며 기존 검색 성능을 바꿨다고 주장하지 않는다.
- 새 테스트32개: 엄격 입력/인증/저장 후202/동시 중복/충돌/용량/저장 장애/잠금/시간 초과 후 재전송/실제 앱 재시작 복구/FIFO 추월 방지를 검증했다. 전체 uv run pytest -q350개 통과(17.20초). 실제 BE/OpenAI/Qdrant 호출·운영 DB 쓰기·커밋·푸시·배포는 하지 않았다.
- 필수 TOML 설정 및 초기화 순서 정리 후 전체350개 재통과(14.77초). 로컬 Docker 이미지 빌드는 Docker Desktop Linux 엔진 파이프가 없어 시작하지 못했다. 따라서 Linux 컨테이너/볼륨의 실제 권한 동작은 아직 미확인이다. Compose 구성은 실제 .env 대신 임시 가짜 환경 파일과 config --quiet로 검증 통과했다.

### 2026-10-30 FAQ 추가·수정·삭제 연동 설계

- 평가 브랜치의 ai/ 미커밋 자료를 '직접 발화 평가 준비 자료 보존 2026-10-30' stash로 보존했다. 사용자 기존 tmp/와 private 자료는 그대로 유지했다.
- develop-ai는 fetch 결과 c90cc00으로 이미 최신이다. 별도 codex/faq-management-plan을 만들었으며 신규 Jira는 미정이다.123/124를 새 CRUD 작업 이슈로 임의 배정하지 않았다.
- origin/develop-backend를9637d59까지 조회하니 FAQ 관리자 POST/PATCH 및 AI GET /api/ai/faqs 목록·상세가 이미 있었다. question/answer/faqEntrySeq/updatedAt 응답을 재사용한다. DELETE와 활성/비활성 및 동기화 알림은 현재 범위에 없으므로 구현됐다고 전제하지 않았다.
- docs/faq-management-plan.md에 기존 API 예시와 추가 삭제 계약, 백엔드 원본 모드, 불변FAQ ID/입력해시/버전포인트, 변경 입력만 임베딩, BM25·Qdrant 동일 판본 활성화, 재시작 복구·job 상태·신규 내부 동기화 API를 제안했다. 첫100건 이하 단일 목록 조회만 완전한 원본으로 인정하고 다중페이지는 강한 snapshot 지원 전 삭제 적용을 금지하는 MVP 범위를 명시했다.
- 기존 원문 해시 강제/내용 기반 chunk ID/1FAQ1청크/1,000포인트 제한·검색 설명 바인딩을 바꿔야 한다. 백엔드20,000자 답변과 Qwen1024토큰의 간극, 긴 표·자식청크 처리와 검증을 계획했다.
- 최초 기존 MD→백엔드 seed는 출처/분류 제거로 입력이 달라32건이 한 번 재임베딩될 수 있음을 명시했다. 정상 증분의 API 절약과 최초 이전 비용을 구분한다. 준비 실패/잘못된빈목록/부분조회/삭제복구·진행중검색 경계를 문서화했다.
- 공식 Qdrant 포인트/컬렉션 문서 확인. 최신 문서 새옵션을 운영1.13.4 지원으로 가정하지 않는다. 실제 API 구현·운영 조회/벡터쓰기·임베딩·테스트 실행·커밋·푸시·배포는 하지 않았다.

### 2026-10-30 브랜치 이름 팀 전략 준수 정정

사용자가 codex 접두어가 팀 전략과 다르다고 지적했다. 설계 문서와 미커밋 변경을 유지한 채 feature/S15P31D109-123-faq-management를 생성하고 기존 codex/faq-management-plan 로컬 브랜치는 git branch -d로 안전 삭제했다. work.md와 설계안의 현재 브랜치 표기를 갱신했다. 기존 stash/tmp/private 데이터는 변경하지 않았고 커밋·푸시는 하지 않았다.

### 2026-10-30 FAQ 관리 변경 범위 확정: 기존 검색 파이프라인 보존

사용자는 검증한 성능을 유지하기 위해 입력·관리 연동 외 기존 처리를 유지하도록 명확히 했다. 설계안의 신규 자식청크/임베딩 입력 단순화 제안을 기본 범위에서 제외하고 기존 제목+재귀800/50·FAQ1청크·search_documents 원문+유효 설명·large3072·Kiwi/BM25·RRF0.4/0.6 c60 Top5·고정Qwen·Top3·responses를 보존하도록 갱신했다. JSON adapter, ID/버전/변경분 등록, 검색 자료 갱신만 변경한다. 긴 FAQ와 중복제목 등 기존 계약 초과는 오류로 보고하며 별도 평가 전 지원을 넓히지 않는다. 같은32FAQ의 실제 입력/청크 비교와 회귀 전 성능 동등을 단정하지 않는다. 실행 코드·운영 설정·DB는 변경하지 않았다.

### 2026-10-30 FAQ 관리 계획 v2 재작성 및 전달본

사용자가 긴 FAQ 지원이 유리하면 허용하며 계획서를 다시 요청했다. 기존 청킹 확장을 전부 제외했던 이전 문구를 v2에서 대체했다. 짧은FAQ는 기존 방식, 긴FAQ는 같은 질문과 표/목록 문맥을 보존한 자식청크로 지원한다. 임베딩 원문+유효설명, 모델/차원, Kiwi/BM25, RRF 비중/Top5, 고정Qwen/Top3, 현재responses는 유지한다.

새 자식청크의 FAQ/버전 ID, 입력해시, 수정 경계 변화와 질문변경 시 재임베딩 범위, Qwen 전체1024토큰 예산, 삭제 시 모든 자식청크 제외를 명시했다. 등록과 요청 단계의 길이검증 및 동일FAQ 후보 편중을 평가한다. 긴질문/분리불가 표 등 한도초과는 조용히 자르지 않는다. 정확한 tokenizer 예산·반영 상태 연결·삭제 계약은 구현 전 협의 항목으로 남겼다.

상세 docs/faq-management-plan.md와 팀원용 docs/faq-management-backend-handoff.md를 작성하고 work.md를 갱신했다. 기존 API와 신규제안을 구분하고 JSON 예시 및 문서 링크를 점검했다. 새 알고리즘 성능 개선/동등을 평가 전 보장하지 않는다. 이번 요청은 계획 문서만이며 실행 코드/API/운영 DB·임베딩·테스트 호출·커밋·푸시·배포는 하지 않았다.

### 2026-10-30 FAQ 관리 v3: 사용자 확인에 따른 이벤트 수신과 실제 삭제

사용자가 BE는 변경시에만 AI로 보내며 추가/수정 복수건·삭제단건이라고 정정했다. 기존 v2의 전체목록 비교/수동sync를 기본경로에서 제거하고 v3와 전달본으로 다시 정리했다. POST upsert(items)와 delete(단건ID)는 제안일 뿐이며 실제JSON을 받아 경로/필드/순서를 확정한다. 삭제는 백엔드조회 없이ID로 처리하고 모든 자식청크·예전버전·준비중 포인트를 벡터DB에서도 실제삭제/0건확인한다. BM25/캐시/진행중검색 반환도 제외하며 DB정리 실패는 완료로 위장하지 않는다. 옛수정이 삭제후 되살아나는 문제를 eventId·FAQ별revision·영속삭제이력·쓰기순서제어로 막는 계약을 제안했다. 백엔드커밋후 전달/영속재시도와 AI202접수/실제APPLIED 결과확인도 구분했다. 최초전체가져오기와 장애복구만 기존조회API를 활용한다. 실제API/DB/검색코드/커밋/푸시는 변경하지 않았다.

### 2026-10-30 실제 병합된 FAQ 계약 확인 및 v4 정렬

최신 develop-backend ce92b13의 FAQ controller/DTO/worker와 docs/api/ai-faq-integration.md를 확인했다. 사용자 최종 확인대로 추가·삭제는1~100건, 수정은1건이다. 관리자DELETE는 /api/faqs에faqEntrySeqs배열이며 /{id}경로가 아니다. AI 알림은 POST /internal/faqs/refresh, AI_FAQ_TOKEN, eventId/operation/faqEntrySeqs이고 본문/revision은 없다. INSERT/UPDATE 후 번호필터 GET으로 최신 원문을 조회하며 정상완전응답에서누락된ID는삭제처리한다. AI가영속접수후2초내202하고FIFO/중복제거/내부반영재시도를담당한다. 최종색인회신API는현재없다. 앞서임의제안한revision/upsert/delete경로/직접본문푸시를v4에서철회하고두문서를맞췄다. 원격develop-ai e6ecf6b 추가변경은조회만했으며현재작업브랜치에병합하지않았다. 실제API/DB/임베딩/커밋/푸시는실행하지않았다.

### 2026-10-30 FAQ 관리 2단계: 대상 원문 조회와 색인 입력 준비

- BackendAPI.faq_entries에서 GET /api/ai/faqs를 번호 필터·limit=100·offset=0으로 호출한다. 요청 번호는 HTTP 전에 검증하고 기존 BACKEND_API_URL/백엔드 timeout을 사용한다. 알림 접수 제한2초와 별개인 후속 조회 작업이며 이번 단계에서는 자동 소비자에 연결하지 않았다.
- 같은 HTTP 클라이언트의 쿠키/기본 헤더를 상속하지 않는 요청을 만들어 관리자 쿠키·페르소나 토큰·통화 헤더를 전달하지 않는다. 기본 클라이언트가 리다이렉트를 따르더라도 FAQ 조회는 따르지 않는다.
- app/rag/faq_source.py에 엄격한 FAQ 원문/목록 모델과 FaqLookup/FaqRefresh를 추가했다. 양의 정수 번호, 질문1000자/답변20000자, 빈문자열/NUL 금지, UTC ISO 시각, data/hasNext, 대상 번호/중복/정렬을 검증한다. 질문·답변의 공백·줄바꿈·Markdown 표를 수정하지 않는다.
- 정상200이며 hasNext=false인 완전한 목록에 대해서만 누락 번호를 삭제 대상으로 계산한다. 부분조회·잘못된 항목·누락 필드·요청 밖 ID·HTTP404/5xx·네트워크/JSON 오류는 빈 결과가 아니라 BackendError다. 오류 코드는 고정하며 원문/상세 예외를 노출하지 않는다.
- prepare_faq_refresh는 INSERT/UPDATE의 갱신 원문과 누락 삭제 번호를 구분하고 DELETE는 원문 조회 없이 번호를 준비한다. 조회 성공만으로 큐를 APPLIED로 바꾸지 않는다. 조회 실패가 선행 작업 완료나 후행 작업 추월로 이어지지 않는 경계를 기존 영속 큐와 함께 검증했다.
- 새로운 가짜 테스트64개를 추가했고 전체414개가15.22초에 통과했다. 정상 빈/부분 누락,100건, 원문 바이트에 해당하는 문자열 보존, 잘못된 응답/필터, 헤더 격리/timeout 적용, 리다이렉트 거부, DELETE 조회 생략, 큐 상태 경계를 검증했다. 실제 BE/OpenAI/Qdrant 호출·운영 DB 쓰기·커밋·푸시·배포는 하지 않았다.
- spec/faq-sync.md, spec/backend-api.md, 계획서 구현 현황과 work.md를 갱신했다. 다음은 JSON 원문→검색 문서 변환과 FAQ/청크ID·입력 해시·긴 FAQ 청킹이다. 자동 소비자·실제 증분 색인/삭제는 남아 있어 수신 기본 비활성을 유지한다.

### 2026-10-30 FAQ 관리 3단계: JSON 검색 문서·관리 ID·청킹·입력 해시

- app/rag/faq_documents.py에서 FaqEntry를 불변 준비 결과로 변환한다. 짧은 FAQ는 질문+답변 원문을 한 청크로 보존하고 긴 문단은 질문/ATX 제목/상위 절 문맥을 반복한 뒤 남은 문자 예산에 RecursiveCharacterTextSplitter를 사용한다. 크기800/겹침50은 server.toml에 두며 겹침>=크기는 기동 검증에서 거절한다.
- 불변 FAQ 관리번호 backend-faq:{번호}, 질문/답변 원문 해시, AI 내부 판본, UUID5 포인트/청크ID, 실제 입력+모델/차원/형식 임베딩 해시를 구분했다. 수정시각만 달라지면 입력/ID를 유지한다. 같은 질문의 별개 FAQ는 관리 ID로 구분하며 입력이 같은 자식 벡터의 재사용 판정 키도 준비했다. 실제 캐시나 임베딩 호출은 아직 없다.
- 같은 FAQ 수정 시 새 판본 포인트 ID를 만들어 활성 원본을 덮지 않을 준비를 한다. 일부 자식의 실제 입력이 같으면 해당 임베딩 해시는 유지한다. 원문과 검색 설명을 분리하고 FAQ 번호/원문 해시가 맞는 설명만 기존 suffix 형식으로 붙인다. 오래된 설명을 새 원문에 몰래 재사용하지 않는다.
- 긴 pipe 표는 질문/절 문맥/조건/머리글/구분행을 반복하고 데이터 행을 온전히 유지한다. VAT 안내가 글머리표이거나 상위 절에 있어도 문맥으로 보존한다. escaped/인라인 코드 pipe를 열 구분으로 오인하지 않는다. 목록은 금지/예외 설명과 부모/하위 항목을 분리하지 않고, fenced 코드 내부 제목/표는 구조로 오해하지 않는다. 큰 단일 행/목록 항목/코드/문맥과 잘못된 열 수는 명시적으로 실패한다. 임의 HTML/병합 표 등까지 지원한다는 뜻은 아니다.
- 배치 전체가 준비돼야 반환하며 일부 실패 항목을 조용히 제외하지 않는다. scripts.inspect_faq_json으로 저장된 실제 API JSON 또는 원문 배열을 API/DB 없이 살펴볼 수 있다. 원문 파일은 수정하지 않는다.
- 테스트 중 새 검색 설명의 앞뒤 공백이 기존 load_descriptions 경로와 다르게 유지되는 문제를 발견해 기존과 동일하게 strip한 뒤 suffix로 전달했다. 표 밖 VAT가 일반 문장이 아니라 목록일 수도 있어 구조 테스트를 추가하고 조건 보존을 보강했다.
- Git의 develop-backend ce92b13 초기 FAQ32건과 현재 MD를 오프라인 비교했다. 질문32개 일치, 새 청크32개/최대523자, 기존 실제 검색 입력과 동일0개다. 출처/분류/포맷/설명 차이로 최초 이전32건은 신규 임베딩 대상이며 아직 실행하지 않았다. 비교 순번은 실제 BE 번호가 아니다. 결과: data/private/evaluation/results/faq_document_migration_preview_20261030T053754593143Z.json. 이 결과는 검색 정확성 평가가 아니다.
- 새 테스트33개, 전체447개가16.43초에 통과했다. 기존 MD 검색/평가 자료는 유지했다. Qwen 전체1024토큰은 문자800과 다르므로 정확한 tokenizer 기반 등록/요청 검증 및95문항/긴 FAQ 검색 회귀가 전환 전 남았다.
- spec/faq-sync.md·server-config.md, 계획서, work.md를 갱신했다. 다음은 영속 원문/벡터 캐시·변경분 임베딩과 같은 판본의 Qdrant/BM25 반영이다. 자동 소비자는 아직 미연결이며 수신 비활성 유지, 실제 외부 API/벡터쓰기/커밋/푸시/배포는 하지 않았다.

### 2026-10-30 FAQ 관리 4단계: 영속 벡터 캐시·추가/수정 증분 색인·검색 판본 전환

- faq_index_state.py에 SQLite 원문/청크 판본·세대·입력별 임베딩 캐시·FAQ별 캐시 참조를 만들었다. 같은 모델/차원/컬렉션/형식의 상태만 열고 체크섬을 확인한다. 읽기 세대와 원문은 같은 SQLite 트랜잭션에서 가져오며, 판본 교체는 세대 비교 조건을 걸어 커밋한다.
- faq_index.py는 등록 검증기→후보 Kiwi/BM25→캐시 누락 해시만 묶음 임베딩→준비 포인트 검증→전체 판본 검증→디스크 커밋→검색 객체 교체를 수행한다. 성공한 임베딩 묶음을 다음 RPC 전에 디스크에 저장해 부분 실패 재시도 때 재사용한다. 응답을 받기 전에 임베딩 연결 자체가 끊긴 경우의 이중 비용까지 보장하지는 않는다.
- faq_vectors.py는 기존 컬렉션의 unnamed/Cosine/차원을 확인하고 UUID 포인트를 wait=true/strong ordering으로 쓴다. 조회해 본문/메타데이터와 벡터 방향을 검증한다. Cosine 정규화/float32 차이는 고려하며 캐시 벡터는 개수/차원/숫자/유한 float32/비영 여부를 검사한다. 방향 검증에서 벡터 길이는 한 번만 계산해 차원 수 제곱으로 계산이 늘지 않게 했다.
- 판본별 정확한 ID 필터로 검색해 이전/실패한 준비 포인트를 제외한다. 기존 HybridSearchExperiment에 청크ID별 검색 입력 선택 경로를 추가해 같은 질문의 별개 FAQ/자식 청크도 BM25에는 실제 임베딩 입력을 쓰고 결과 근거에는 원문만 반환한다. 기존 MD의 제목별 설명 경로·Kiwi/BM25 파라미터·RRF 비중/c는 유지한다.
- 준비 중에는 기존 검색 객체를 유지하고, 이미 시작한 추가/수정 전 검색은 캡처한 원문/BM25/ID 집합으로 끝낸다. Qdrant와 SQLite의 분산 원자 트랜잭션을 주장하지 않는다. 새 포인트 저장 응답 유실은 같은 ID로 재시도하고, 커밋 직후 프로세스가 끝난 경우 재시작 시 디스크 판본과 포인트를 검증해 문서 재임베딩 없이 복구한다.
- faq_sync.collection을 기존 MD와 다른 관리 전용 이름으로 설정하고 두 컬렉션이 같으면 기동 검증에서 거부했다. embedding_batch_size=32를 추가했다. 실제 컬렉션 자동 생성/초기화/삭제나 운영 설정 전환은 수행하지 않는다.
- 삭제는 모든 버전/캐시/진행 중 검색을 함께 다뤄야 하므로 이번 추가·수정 모듈에서 delete_ids를 받으면 변경 전에 명시적으로 거부한다. 큐 완료/운영 자동 소비자/실제 Qwen 등록 길이 검증기/운영 RagService 전환은 아직 미연결이다. 수신은 비활성으로 유지한다.
- 새 테스트26개, 전체473개가20.90초에 통과했다. 임시 SQLite·메모리 Qdrant·가짜 임베딩으로 부분 자식 재사용, 같은 입력 중복, 묶음 실패, 응답 유실, 커밋 실패/직후 종료, 검색 중 판본 전환, 손상 캐시/원문, 누락/변조 포인트, 미완료 ACK와 실제3072차원 왕복을 검증했다. 운영1.13.4 서버 실연동이나95문항 정확성 평가를 대신하지 않는다.
- 기존 langchain-community 유지보수 종료 DeprecationWarning1건을 관측했다. 이번 작업에서 경고를 숨기거나 검색 라이브러리를 교체하지 않았다. 공식 Qdrant 포인트/필터 문서와 설치된 SDK 메서드 인수를 참고했다.
- spec/faq-sync.md·server-config.md, 전체 계획/팀work를 갱신했다. 다음은 모든 판본 실제 삭제/0건 확인·캐시 정리·진행 중 검색 반환 차단과 자동 소비자 연결이다. 실제 BE/OpenAI/GCP/운영 Qdrant 호출·비밀값 변경·커밋·푸시·배포는 하지 않았다.

### 2026-10-30 FAQ 관리 5단계: 모든 버전 삭제·영속 반환 차단·실패 복구

- FaqEventStore가 DELETE 알림과 본문 없는 반환 차단 번호를 같은 SQLite 트랜잭션으로 저장한다. 차단 저장 실패는 알림도 롤백하고503이며,202 뒤 재시작에도 차단을 유지한다. PENDING/CLEANED는 물리 정리 상태이고 CLEANED 이후에도 번호 재사용/옛 수정 부활을 막는 차단은 유지한다.
- FaqIndex.apply는 삭제 차단을 긴 쓰기 잠금 대기 전부터 기록한다. 정상 원문 조회의 누락 삭제도 이 경로를 쓴다. 준비 중 새 차단이 도착하면 후보를 다시 만들고, 최종 SQL 트랜잭션에서도 차단된 FAQ를 커밋하지 못하게 한다. 원격 쓰기/삭제를 같은 소비자 잠금으로 직렬화한다.
- Qdrant의 metadata.faq_id 필터로 활성·이전 수정·실패한 준비 포인트를 실제 삭제하고 COMPLETED 및 exact count0을 확인한다. 이미 없던 번호와 반복 삭제도 정상 처리한다. 성공 뒤 원문 판본/캐시 참조/무참조 캐시 제거와 CLEANED를 함께 커밋한다. 다른 FAQ가 공유한 입력 벡터는 보존한다. 삭제에는 임베딩을 호출하지 않는다.
- faq_search.py에서 검색 전/반환 전 현재 차단을 적용한다. 삭제 때문에 조회 대상 포인트가 사라지면 더 작은 허용 집합으로 재검색하며 질문 벡터는 요청 내에서 한 번만 계산한다. 무관한 네트워크 오류는 숨기지 않는다. FaqIndex.filter_rows를 리랭킹 뒤 최종 반환 경계로 제공했다. 실제 Live 경로 연결은 아직 남았다.
- 삭제 RPC 응답 유실·원격 삭제 후 SQL 실패에도 차단/PENDING을 유지한다. 시작 시 차단 대상은 원문 파싱/벡터 검증에서 먼저 제외해 손상된 삭제 대상도 정리하고, 모든 삭제 이력을 재확인한다. reconcile_deletions로 늦게 나타난 포인트도 정리한다.0건 확인은 그 시점의 관측이며 미래의 외부 쓰기 영구 차단을 주장하지 않는다. 자동 주기 점검은 다음 소비자 단계다.
- 새 삭제 테스트15개와 API 경계2개를 추가했다. 전체490개가25.18초에 통과했다. 현재/옛/준비 버전 일괄 삭제·공유 캐시·삭제 실패/응답 유실/SQL 실패·재시작·손상된 삭제 원문·임베딩/준비/커밋/검색과 겹친 삭제·늦은 쓰기·최종 반환 필터를 임시 DB와 가짜 임베딩으로 검증했다. 기존의 삭제 거부 테스트는 실제 정리 테스트로 대체했다.
- 첫 통합 실행에서 기존 시간 초과 테스트의 재시도도50ms로 묶여1건 실패했다. 고정 sleep 대신 스레드 시작/해제/완료 이벤트로 순서를 제어하고 재시도 전에 정상1.5초 설정을 복원해 불안정한 테스트를 고쳤다. 운영 제한을 완화한 변경은 아니다. 이후 전체489개, 손상 원문 경계 보강 후490개가 통과했다.
- spec/faq-sync.md·계획서·work.md를 갱신했다. 논리 행/포인트 제거와 과거 MD/백업/WAL의 포렌식 소거는 구분하며, 이미 모델에 전달하거나 발화한 말은 소급 회수하지 않는다. 단일 프로세스/소비자 및 FAQ 번호 미재사용 전제다.
- 다음은 FIFO 자동 소비자/실제 등록 길이 검증기/운영 검색과 리랭킹 후 반환 연결이다. 수신은 기본 비활성, 기존 MD 검색 유지이며 실제 운영 서버/API/비밀값/유료 임베딩·커밋·푸시·배포는 변경하지 않았다. 기존 langchain-community 경고1건은 숨기지 않았다.

## 2026-10-30 (LangGraph 흐름 전면 재구성, `spec/LANGGRAPH_REBUILD.md`)

### 바꾼 것
- 통화 흐름을 flow_final.drawio(지시서 §4~§6)대로 교체: 노드 42개, 이름 = 다이어그램 ID. 단계 정의 `app/flow/stages/`를 `entry`(진입·HUB·END_CALL)·`new_order`(A)·`order`(B)·`lookup_orders`(C)·`qna`(D) 다섯 파일로 다시 씀. 옛 단계(collecting·confirming·after_order·recent_offer·find_*·address·handoff·ending·HELD) 삭제.
- 엔진(`app/flow/engine.py`)은 LangGraph 구조(사건 하나 = 실행 한 번, 통화 객체를 context로)를 유지하고 넓힘: 전이 문구(`say`)와 단계 질문(`ask`), 같은 단계 예외(`STAY`), 확정 지연(`commit` → `COMMIT`), 사건 넘김(`forward`), 복귀(`resume` + `RETURN`, 고정 엣지 없음), 끝내는 단계(`final`), 진입 시각(`entered_ms`), 정정 중 다시 묻기. `MAX_HOPS` 10.
- 판별(`app/listener.py`): 출력 스키마에 전역 의도(question·restricted·correction·wait·end)와 정정 항목(`slot`) 추가, 전역 의도 먼저. §2.5: 판별 리비전(`heard_rev`, 판별 중에 온 말이 지워지던 문제도 함께 고침), 질문 핵심 구간을 듣기 전 답(`[core]`, 한 번 다시 묻기), 늦게 온 꼬리 조각·듣지 않는 단계의 말 따로 쌓기, 확정 지연 멈춤·다시 재기, 정정. 옛 `answer_failures`→상담원 제안, `quit` 의도 삭제.
- sideband: `watch_flow`(확정 지연·검색 대기·쌓인 말 판별), 서버 실행 도구(취소)와 통화 종료 시 쓰기 결과 기다리기, 마무리 인사 바로잡기(`instructions.append`).
- 도구: `match_pins` 새로(핀 매칭 결과 분기), `lookup_orders`(받는 분 성함), `cancel_order`(서버만 실행·작업 번호·재시도 전 조회), `search_manual`(RAG Yes/No 사건), `record_order`(주소 확정 흡수·정정 감지·지난 수거 일시). `live.toml` 백엔드 도구에서 `cancel_order`·`modify_order` 뺌, `match_pins` 넣음.
- 문구 `prompts/flow.toml` 새로(`[say]` 지시서 ID별 글자 그대로, `[note]`, `[core]`, `[status_names]` 등), `voice.md`·`backend.md`를 새 흐름에 맞춤(서비스 질문 직접 답 금지·스스로 끝내지 않기·값 바꾸지 않기, 위임할 것). 설정 `[flow]` 새로, `[rag] min_score`(선택).
- 문서: `spec/flow.md`·`scenario.md`(구현 결정만)·`sideband.md`·`tools.md`·`backend-api.md`·`address.md`·`server-config.md`, AGENTS.md. Studio 그래프도 새 엔진에 맞춤.

### 확인한 것
- Phase 0: 진입 경로 셋(① `sideband.py:100`→`listener.py:77`→`listener.py:188`, ② `sideband.py:91`→`dispatcher.py:50`, ③ `sideband.py:204`)을 실행 추적으로 확인한 뒤 인터페이스는 유지.
- SDK 타입으로 `session.input/output_transcript.delta`의 `start_ms`·`end_ms`(세션 타임라인 ms), `session.instructions.append`(500토큰, Responses 위임에서 `delegation_id` null) 확인.
- 테스트 340개 통과(§8 시나리오 25건 포함, 시각을 쓰는 sideband 테스트 12회 반복 통과). 실제 OpenAI·PBX·백엔드는 부르지 않음.

### 남은 것(결정 대기)
- 지시서 §10 보완사항 28건: 택배 담기 전 최종 확인 없음(안전장치 충돌), 핀 매칭을 도구에 맡긴 위험, §2.5(1)과 시나리오 16 모순, 운임·현장 결제 값·조회/취소 API·핀 날짜·상담원 가능 여부 데이터 없음 등.
- 실제 통화 확인: 받아쓰기 시각 지연, `commit_delay_ms` 적정값, 출력 받아쓰기 숫자 표기, 판별과 검색의 순서.
- 개인 개발로그 경로(`C:/Users/SSAFY/Desktop/자율/개발로그.md`)가 없어 적지 못함.

## 2026-10-31 (관제 화면: 상태 그래프)

### 바꾼 것
- 관제 화면에 "그래프" 버튼: 단계 정의의 전이로 그린 Mermaid 그림에 선택한 통화의 지금 노드(파랑)·거쳐 온 노드(옅은 파랑)를 칠하고, 지금 노드로 스크롤한다. SSE로 단계가 바뀔 때만 다시 그린다.
- API `/monitor/api/graph`(인증 뒤). 흐름별 묶음을 위해 `engine.GROUPS`(단계 → 정의 모듈)를 추가.

### 확인한 것
- 전체 테스트 341개 통과(그래프 API 테스트 1개 추가). 생성한 Mermaid 글을 mermaid@11.4.1로 브라우저에서 그려 보고 칠하기·스크롤 확인.

### 남은 것
- Mermaid를 CDN(jsdelivr)에서 받으므로 관제 화면을 보는 PC가 인터넷에 닿아야 그림이 나온다.

## 2026-10-31 (흐름 개정 반영: dva_mvp_flow.drawio)

### 바꾼 것
- 지시서(`spec/LANGGRAPH_REBUILD.md`) 개정 반영. 기존 고객 인사가 기존 출발지 확인 질문(`B_GREET_CHOICE`)이 됨: 예 → 바로 접수, 아니오 → "무엇을 도와드릴까요?" → HUB, 조회·취소 용건 → 조회.
- B 흐름: 출발지 핀 매칭 7개 노드 삭제. `B_ORIGIN_ROUTE`(기존 출발지 / 새 출발지) → `B_ORIGIN_CHANGE`(보내는 분은 그대로, 주소만) → `B_LOAD_RECENT` → `B_DEST_CONFIRM_Q`("이번에도 {도착지 주소}로 보내시나요?") → 아니오면 도착지 핀 매칭.
- 도착지 핀 매칭: 말한 이름·장소를 합쳐 찾고, 없는데 한쪽만 말했으면 빠진 쪽을 묻는다. 받는 분 확인 아니오(B11) → "{수신인}님으로 저장된 다른 배송지가 없으니 새로 접수하겠습니다." → 수신인 정보 Hub. 핀이 없으면 말한 이름·주소(숫자가 있는 장소만)를 가져간다. 최근 N개(`[flow] pin_recent_count`=5) 핀 먼저.
- A 흐름: 보내는 분 전화번호 질문 삭제(발신번호로 등록). `A_RECEIVER_HUB`(받는 분 성함·연락처·주소 중 빈 것만) 추가, `A_REGISTER_RECEIVER`는 등록만.
- 최근 접수 1건: 이번 통화에서 담은 택배, 없으면 백엔드 고객 확인의 최근 접수(`CallerContext.recent_origin`·`recent_destination`, 가짜 백엔드만 채움).
- 첫 인사도 질문을 다 듣기 전 "예"는 다시 묻는다(받아쓰기 전 세션 시각을 0으로).
- 보완사항을 지시서 §10에서 `spec/LANGGRAPH_REVIEW.md`로 옮기고 이번 결정 9건과 새 항목(29~32)을 적음. AGENTS.md·spec 참조 수정.

### 확인한 것
- 전체 테스트 356개 통과(DeprecationWarning 오류 처리). 시나리오 1~4(3-1·3-2 포함)·15·16·20 다시 작성, sideband 테스트 6회 반복 통과.

### 남은 것
- 백엔드 고객 확인 응답의 최근 접수 필드(미정). 받기 전에는 실제 통화에서 기존 고객도 출발지 없이 인사하고 새 출발지부터 받는다(보완사항 29).
- 보완사항 1(택배 담기 전 최종 확인 없음) 등 결정 대기 항목은 그대로.

## 2026-10-31 (백엔드 주문·결제·취소 연동 규격 반영, S15P31D109-138)

### 바꾼 것
- 백엔드 계약 원문을 `develop-backend`에서 다시 받아 옴: `spec/ai-order-billing-integration.md`(새), `spec/order-address-history.md`(새), `spec/orders.md`·`spec/ai-pbx-recordings.md`(갱신). `spec/backend-api.md`는 AI가 쓰는 방식으로 다시 씀.
- 고객 확인에 통화(`providerCallId`·`incomingAt`)를 보내고 통화 번호(`callSessionSeq`)·결제 자격(`availablePaymentMethods`)을 받는다. 등록 고객이면 이전 접수 주소(`GET /api/customers/{id}/addresses`)로 기존 출발지·최근 도착지를 채운다.
- 조회·취소를 새 API로: 목록 → 주문 상세로 택배 단위(받는 분·주소·상태), 상세 취소(`POST /api/orders/{id}/parcels/cancel`, 204·409·404). `call_session_seq` 헤더. 받는 분 성함은 URL에 넣지 않고 서버가 거른다. 취소 가능은 COLLECTING·notPaid, 결제가 끝난 뒤는 C7_LOCKED.
- 배송비: 서버 요금표 `[fare]`로 택배별 `notifiedPrice`·`totalAmount`. 값이 비어 있으면 운임을 말하지 않고 미완료로 넘김(지금 비어 있음).
- 결제 방식: 후불 자격이 하나면 그것, 둘이면 `A_PAYMENT`에서 묻고(고른 답은 확정 지연 뒤 정함), 없으면 개인 카드. A6 뒷문장을 방식별 안내로, 개인 카드 결제 대기(notPaid)는 END_NOT_PAID.
- 통화 결과 응답 200(같은 키 재요청) 처리, 새 상태(notPaid·PAID·SUBMITTING·ACCEPTED·SUBMISSION_FAILED) 안내 표. 가짜 백엔드를 새 계약으로 다시 씀.

### 확인한 것
- 전체 테스트 368개 통과. 응답 필드·헤더·정렬은 `origin/develop-backend`의 DTO·저장소 코드로 확인(규격서에 없던 목록·상세·주소 이력의 응답 모양).

### 남은 것
- 요금표 값(운영 결정). 정해지기 전에는 모든 접수가 미완료로 넘어간다.
- 수거 시각 계약 충돌(보완사항 33), 개인 카드 결제 메시지 미연결(34), 주소 이력이 ACCEPTED 주문만이라 결제 대기 고객은 최근 접수가 없음(29).
- 실제 백엔드로 통화 확인은 하지 않음. `call_session_seq`(밑줄 헤더)가 프록시를 거치면 버려질 수 있음.

## 2026-10-31 (운임표·수거 시각·신규 고객 등록 시점)

### 바꾼 것
- 운임표: `config/server.toml` `[fare]`에 유인 지점 요금(서류 3,850·소형 4,950·중형 6,050·대형 7,150원). 방문수거는 유인 지점 요금으로 결정. 이제 요금표로 운임을 안내하고 COMPLETE를 보낸다.
- 수거 시각: 사용자가 전달한 S15P31D109-138 연동 규격(최초 확정 시 미래 시각 필수)으로 결정. 백엔드 원문을 옮긴 `spec/ai-order-billing-integration.md`·`spec/orders.md`의 "서버가 결제 완료 + 1시간" 문장을 고치고 AI 팀 결정이라고 표시. 코드는 그대로(고객이 말한 시각을 보냄).
- 신규 고객은 보내는 분 정보(성함·주소)를 다 말한 순간 `POST /api/customers`로 등록하고 보내는 곳을 개인 주소록(`POST /api/customers/{id}/pins`)에 저장, 이때부터 기존 고객(결과는 customerSeq). 실패하면 신규로 계속.
- 기존 출발지: 접수 완료 주문이 없으면 본인 주소록 주소(발신번호의 핀)로.

### 확인한 것
- 전체 테스트 373개 통과. 고객 등록·주소록 API의 요청·응답과 통화 고객 확인 방식(발신번호로 매번 찾음)은 `origin/develop-backend` 코드로 확인.

### 남은 것
- 백엔드 문서·구현의 수거 시각 규칙을 연동 규격과 맞추기(백엔드 팀).
- 등록 뒤 보내는 곳을 고쳐도 주소록은 고치지 않는다(TODO(flow)). 기타 물품(규격 없음)은 운임을 몰라 미완료.

## 2026-10-31 (관제 화면 수정·통화 로그 확인)

### 바꾼 것
- 관제 화면 스크립트 문법 오류 수정(그래프 추가 때 줄바꿈이 문자열에 들어가 화면 전체가 멈춤). 그래프 라이브러리(CDN)를 못 받아도 관제는 동작. 인라인 스크립트 문법 검사 테스트(`node --check`, node 없으면 건너뜀).
- 관제 화면에 접수 완료해 담은 택배의 확정 내용(항목·운임)·운임 합계, 고객(신규·등록·고객번호)·수거 희망·결제 방식을 표시. 받는 중인 택배는 담은 뒤 비워져 확정 내용이 안 보이던 문제.
- 신규 고객 등록(보내는 분 정보 등록 완료 시 백엔드로 한 번) 결과를 로그에 남김(고객번호·주소록 저장 여부만).

### 확인한 것
- 재빌드 뒤 통화 2건 로그: 1번은 늦게 온 말 조각이 받는 곳 주소 정정으로 판별돼 다시 물었고, 다시 기록된 주소("인동구길", 길 번호를 한글로)를 못 찾아 좌표 없이 담겨 미완료. 2번은 B6 뒤 판별이 제한된 요청으로 빠져 종료(받아쓰기 없이는 원인 불명). 매뉴얼 검색은 리랭커 접속 시간 초과.
- 컨테이너가 가짜 백엔드(BACKEND_MOCK)로 떠 있어 실제 백엔드로는 아무것도 가지 않음.

### 남은 것
- 확정된 주소를 다시 기록하다 못 찾으면 지우지 말고 다시 묻기, 늦은 조각의 정정 판별 기준, 도구 호출 로그(이름·사건만) — 결정 대기.

## 2026-10-31 (답에 따라 이어서 할 말 미리 알려 주기, 첫 인사)

### 확인한 것(서버 컨테이너 통화)
- 신규 고객이 "택배 접수할게요"라고 하자 음성 모델이 진행 상태가 오기 전에 스스로 "어디에서 보내시나요?"를 묻고, 진행 상태(A1_1)가 온 뒤 다시 성함을 물음. 고객 말이 끝나면 음성 모델이 바로 말을 시작하는데 판별·진행 상태는 말 멈춤 대기 + 판별(약 2초) 뒤에 온다.

### 바꾼 것
- 답을 고르는 단계의 진행 상태에 답마다 바로 이어서 할 말을 붙임(`engine.preview`, 문구 `progress_preview`·`progress_preview_item`). 답의 사건 이름 끝이 선택지 값인 전이를 찾아 들어갈 단계의 첫 질문을 계산하고, 가는 길이 답 처리 결과에 따라 갈릴 수 있는 곳은 뺐다.
- `voice.md`: 용건 답도 포함해, 미리 받은 이어서 할 말이 있으면 그것을, 없으면 "네"만 하고 기다림. 이미 물은 질문을 진행 상태가 또 시키면 되풀이하지 않음.
- 처음 이용하는 고객 인사: "안녕하세요. 디바콜입니다."(`prompts/persona.md`).
- 테스트 579개 통과(1개 추가).

### 남은 것
- 실제 통화로 확인: 이어서 물은 질문을 진행 상태가 다시 시킬 때 되풀이하지 않는지. 백엔드 관리 화면의 ACTIVE 페르소나가 있으면 인사는 그쪽 문구가 나감.
