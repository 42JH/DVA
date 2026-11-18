# 통화 불만 판정 (Jira 148, 후처리)

끝난 통화의 저장된 기록(대본 · AI 동작 · 업무 결과) · 녹음 · FAQ 원문으로 화면의 불만 6유형을 판정해 `call_analyses`의 `has_complaint` · `complaints`를 채운다.

## 방식

- **실시간 상담 경로와 무관한 후처리**다. AI 서버는 불만을 판정하지 않고 분석을 `hasComplaint: null` · `complaints: []`로 보낸다(변경 없음).
- 백엔드 워커(`ComplaintJudgeWorker`)가 AI 분석이 저장된 통화 중 `has_complaint IS NULL`인 것을 **최신부터** 하나씩 집어 판정하고, 그 행의 두 칸만 UPDATE한다.
  - `repeat_question_count` 등 AI가 보낸 다른 칸은 바꾸지 않는다. AI의 같은 분석 재전송은 저장된 `payload_hash`로 비교하므로 409가 나지 않는다.
  - 목록 · 상세는 판정 결과와 책임·강도·참고 표시를 읽고 통계는 AI 품질 대상만 집계한다.
  - **지난 통화도 같은 방식으로 자동으로 채워진다.**
- AI 분석이 오지 않은 통화(행 없음)는 판정하지 않는다.
- 발화가 아직 수집되지 않은 분석은 미판정(NULL)으로 남기고, 발화 이벤트가 도착한 뒤 집는다. 발화 누락을 불만 없음(false)으로 확정하지 않는다. 동일 워커의 주기 호출이 겹쳐도 동시 판정 상한을 유지한다.

| 유형 | 정하는 방식 |
|---|---|
| `INTERRUPTION` 말 끊김 | 코드: AI 말이 문장 중간에 잘리고 고객이 바로 말함 |
| `SLOW_RESPONSE` 응답 지연 | 코드: AI 차례 침묵이 녹음으로 10초 이상, 또는 3초 이상 + 고객이 기다림을 드러냄 |
| `INFORMATION_RECOGNITION_ERROR` 정보 인식 오류 | 코드(번호 복창 불일치 · 인사에서 부른 값 다시 물음) + 모델 |
| `UNSUPPORTED_ANSWER` 근거 없는 답변 | 모델 + 장면 재확인(FAQ 원문과 대조) |
| `INTENT_RECOGNITION_ERROR` 용건 인식 오류 | 모델 + 장면 재확인 |
| `DISSATISFACTION_EXPRESSION` 불만 표현 | 모델(3판 다수결) |

모델은 같은 통화를 3판 동시에 판정해 2판 이상 나온 것만 남기고, 대본에 없는 인용은 버린다.

## 코드

- `src/call-insights/complaints/`
  - `complaint-judge.ts` · `complaint-extract.ts` · `complaint-timing.ts`: 판정 규칙. **기준 구현 `ai/call_analysis`(파이썬)를 그대로 옮긴 것**이다.
  - `complaint-prompts.ts`: `ai/call_analysis/prompt.md` · `verify.md` 원문(손으로 고치지 않음)
  - `complaint-model.client.ts`: OpenAI Responses 호출(구조화 출력, `store=false`, 429 · 5xx 2회 재시도, 한 판 120초)
  - `complaint-judge.repository.ts` · `complaint-judge.worker.ts`: 통화 집기 · 입력 읽기 · 저장
- `test/complaint-judge.test.cjs`: 파이썬 기준 구현의 입력 · 출력 446건(`test/fixtures/complaint-parity.json.gz`, 테스트의 가짜 데이터)과 결과가 같은지
- `test/complaint-judge.integration.test.cjs`: 실제 DB로 집기 · 저장 · 재시도 · 녹음 대기 · 중복 집기 방지(가짜 모델)

## 실패 · 재시도

| 상황 | 처리 |
|---|---|
| 모델 장애 · 시간 초과 · 다수결에 모자람 | 10분 × 시도 수 뒤 다시. **3번 실패하면 미판정(`NULL`)으로 남김** |
| 대본이 4만 자 넘음 | 판정하지 않음(`complaint_attempts=10`, 미판정으로 남김) |
| 녹음이 아직 없음 | 분석 저장 뒤 30분까지 5분마다 다시(시도 수 안 씀). 그 뒤엔 녹음 없이 판정(응답 지연만 빠짐) |
| 녹음 저장소(S3) 오류 | 다시 시도. 마지막 시도엔 녹음 없이 판정 |
| 여러 인스턴스 | `FOR UPDATE SKIP LOCKED` + 10분 임대로 같은 통화를 겹쳐 집지 않음 |

## 배포

1. migration `057-call-complaint-judging.sql` 적용(`call_analyses.complaint_attempts` · `complaint_retry_at` · 미판정 색인)
2. 환경 변수
   - `CALL_ANALYSIS_OPENAI_API_KEY`: 실시간 상담과 다른 전용 키. **없으면 워커가 꺼져 있다**(다른 기능 영향 없음)
   - `CALL_ANALYSIS_CONCURRENCY`: 동시에 판정할 통화 수 1~4, 기본 2(통화 하나가 3판을 동시에 보냄)
   - 운영 값은 서버의 `<배포 루트>/shared/.env`에 넣는다. `infra/deploy/deploy.sh`가 `--env-file`로 읽고, `compose.prod.yaml`이 백엔드 컨테이너에 넘긴다. 저장소에는 키를 커밋하지 않는다.
3. 키를 넣고 백엔드를 다시 띄우면(다음 배포 또는 compose up) 최신 통화부터 판정한다. 지난 통화도 이어서 채워진다.

비용 · 시간(2026-11-06 측정, gpt-6-luna medium): 통화당 약 4~5원, 30초 안팎. 동시 2건이면 시간당 약 240통화.

## 개인정보

- 대본 · 녹음 · FAQ는 모델에 `store=false`로 보내고, 판정 입력 · 사유를 로그에 남기지 않는다. 로그는 통화 번호 · 불만 유형 · 토큰 수만.
- 저장하는 근거 글(`evidenceText`)은 200자 이하이고, 세 자리 넘게 이어진 숫자(번호 · 금액)는 `***`로 가린다.

## 변경 전 기준 구현의 정확도 (2026-11-06, 사람이 매긴 정답 대비)

시험용 50통화: 불만 있는 통화인지 97% / 94%(정밀도 / 재현율), 6유형 구간 · 유형까지 84% / 86%.
유형별로 응답 지연 · 말 끊김 100% / 100%, 정보 인식 89% / 79%, 근거 없는 답변 67% / 80%, 용건 인식 67% / 29%, 불만 표현 62% / 100%.
평가 통화 대부분이 QA 시험 통화라 실제 고객 통화로 다시 재야 한다.

## 판정을 고칠 때

1. `ai/call_analysis`(파이썬)에서 고치고 `evaluate.py`로 점수를 잰다(`ai/call_analysis/README.md`).
2. 같은 변경을 `src/call-insights/complaints/`에 옮긴다. 지시문은 `prompt.md` · `verify.md`에서 `complaint-prompts.ts`를 다시 만든다.
3. 파이썬 테스트를 돌리며 기록한 정답 파일(`test/fixtures/complaint-parity.json.gz`)을 다시 만들고 `test/complaint-judge.test.cjs`가 통과하는지 확인한다.

## MR !476 반영

고객 불만은 해당 차례 고객의 실제 인용과 유효한 책임 대상이 있어야 남긴다. target은 ai_service·price_policy·delivery_other이며 level은 explicit·mild다. 인용을 대조한 다음 번호를 가리고 jsonb에 대상·강도를 함께 저장한다. 다른 유형은 target·level이 null이다.

UNSUPPORTED_ANSWER는 FAQ·업무 규칙·대본에 존재하는 8자 이상의 반대 근거 구절이 있어야 남긴다. 조회의 referenceOnly가 true이며 AI 품질 비율에서는 제외한다. 품질 통화 수에는 응대 오류 4유형과 ai_service 대상 고객 불만만 포함한다. 기존 미상 책임을 AI 책임으로 보완하지 않는다. dropped·candidates·single 등의 판정 점검 값은 저장·응답에서 제외한다.

기준은 call_analysis의 c6bf109f482f6cfa4159a28d09a97595f30b8740이다. 실제 모델 정확도는 이번 가짜 모델 검사에서 측정하지 않았다. 선택 저장 항목인 용건·결과·감정 컬럼은 추가하지 않았다.

재생성은 Python 3.14.6과 numpy 2.5.4·openai 3.35.1·pytest 9.2.0에서 scripts/record-complaint-parity.py에 기준 ai 디렉터리, 출력 gzip, 기존 timing fixture를 순서대로 전달한다. 수정하지 않은 Python 테스트 31개를 실행하고 기존 합성 녹음·타이밍 입력의 정답도 다시 계산한다. 같은 입력으로 두 번 생성한 gzip의 SHA-256 일치를 확인했다.
