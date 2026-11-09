# 통화 불만 판정 — 입력 · 출력 명세 (2026-11-06)

끝난 통화의 저장된 기록 · 녹음 말소리 구간 · FAQ 원문을 넣으면 불만 6유형 · 되묻기를 판정해 돌려준다. **저장 · 재시도 · 화면 제공은 백엔드가 한다.**

방식은 무조건 후처리다(README.md). 전용 OpenAI 키를 쓴다. 지금은 HTTP 서비스(`server.py`)이고, 백엔드 안으로 옮길 때도 아래 입력 · 출력 모양을 그대로 쓴다.

## 언제 부르나 (백엔드)

- **AI의 통화 분석(`POST /calls/{id}/analysis`)을 받은 뒤** **백그라운드에서** 통화당 한 번 부른다. 화면 요청 중에 부르지 않는다.
  - AI는 통화 후 검토 결과(`FAQ_ANSWERED` · `QUESTION_UNANSWERED`)를 이벤트로 먼저 보내고 분석을 맨 마지막에 보낸다. 통화 종료 직후에 부르면 이 결과가 빠져 '근거 없는 답변'을 판정할 수 없다.
  - AI 분석이 오지 않는 통화(전송 실패 등)는 통화 종료 10분 뒤에 부른다.
- 판정 시간: 보통 20~40초, 긴 통화(발화 100개 넘음)는 1분 넘게 걸린다(11/06, medium · 3판 + 장면 확인). 한 판은 최대 120초까지 기다리므로, 백엔드의 요청 시간 제한은 200초 이상으로 둔다.
- 결과는 백엔드 DB에 따로 저장한다. AI가 보내는 분석(`POST /calls/{id}/analysis`)과는 별개라 409와 부딪히지 않는다.
- 통화 목록 · 상세 · 통계(`complaint-calls`)의 `hasComplaint` · `complaints`(· `repeatQuestionCount`)는 이 결과로 채운다. 그러면 프론트는 고칠 것이 없다.
- 지난 통화는 같은 API를 차례로 불러 채운다(동시 2건 안팎).

## 요청

`POST /analyze`

```
Authorization: Bearer <CALL_ANALYSIS_TOKEN>
Content-Type: application/json

{
  "callSessionSeq": 9101,
  "events": [
    { "kind": "AI_ACTION", "occurredAt": "2026-11-05T13:12:00+09:00", "offsetSeconds": 0,
      "payload": { "action": "CUSTOMER_LOOKUP", "summaryText": "등록 고객" } },
    { "kind": "UTTERANCE", "occurredAt": "2026-11-05T13:12:01+09:00", "offsetSeconds": 1,
      "payload": { "utteranceOrder": 1, "speaker": "AI", "utteranceText": "안녕하세요, 디버 택배 접수입니다." } },
    { "kind": "UTTERANCE", "occurredAt": "2026-11-05T13:12:05+09:00", "offsetSeconds": 5,
      "payload": { "utteranceOrder": 2, "speaker": "CUSTOMER", "utteranceText": "택배 보내려고요" } },
    { "kind": "AI_ACTION", "occurredAt": "2026-11-05T13:12:11+09:00", "offsetSeconds": 11,
      "payload": { "action": "FIELD_SAVED", "summaryText": "기록: 1개 항목" } },
    { "kind": "BUSINESS_RESULT", "occurredAt": "2026-11-05T13:15:00+09:00", "offsetSeconds": 180,
      "payload": { "action": "ORDER_CREATED", "summaryText": "택배 접수 주문 저장" } }
  ]
}
```

- `events`는 그 통화의 `call_insight_events`를 `event_order` 순으로 담는다. EVT-01 모양 그대로다(`docs/api/call-events.md`).
- `UTTERANCE`의 `payload`는 `call_utterances`의 `utteranceOrder` · `speaker`(`AI` | `CUSTOMER`) · `utteranceText`로 채운다.
- **`occurredAt`은 그 이벤트가 일어난 시각**(`call_insight_events.occurred_at`)이다. 판정은 이 시각으로 발화와 AI 동작(검색 · 조회 결과)을 차례에 맞춰 붙인다. `call_utterances.received_at`은 백엔드가 기록을 받은 시각(통화 끝에 모든 발화가 같은 값)이라 쓰면 안 된다. 쓰면 'FAQ로 답했는데 근거 없는 답변' 같은 오탐이 생긴다(11/05 실서버 시험에서 확인).
- `AI_ACTION` · `BUSINESS_RESULT`의 `payload`는 AI가 보낸 원본 그대로 넘긴다. 칸을 빼거나 바꾸지 않는다. 판정이 쓰는 칸은 다음과 같다.
  - 모든 이벤트: `action` · `summaryText`
  - `FAQ_ANSWERED`: `answerUtteranceOrder`(FAQ 근거로 답한 AI 발화) · `questionUtteranceOrder` · `faqEntrySeqs` → 그 답은 '근거 없는 답변'에서 뺀다.
  - `QUESTION_UNANSWERED`: `summaryText`의 사유("FAQ 답변 근거 없음" = 근거 부족으로 답하지 않음, "지식 검색 장애로 답변하지 못함" = 서버 장애) → 둘 다 '근거 없는 답변'이 아니다. 서버 장애로 답을 못 한 차례는 그것만으로 불만이 아니다(장애와 상관없는 AI 잘못은 센다).
- 통화 시작 시각은 `CUSTOMER_LOOKUP` 이벤트로 잡는다. 없으면 가장 이른 이벤트로 잡는다.
- 이벤트는 최대 5000개까지 보낼 수 있다.

### `speech` — 녹음 말소리 구간 (선택, 응답 지연 판정에 필요)

```
"speech": [[0.5, 2.5], [4.0, 7.2], ...]   // [시작초, 끝초], 통화 녹음 처음부터
```

- 통화 녹음 파일(WAV 16비트, 지금은 한 채널 8kHz)로 백엔드가 구한다. `timing.speech_segments`와 같은 계산이다.
  1. 20ms씩 잘라 소리 크기(RMS)를 dB로 잰다.
  2. 전체의 하위 10% 값(바닥 소음)보다 15dB 크면 말소리로 본다.
  3. 0.35초 이하로 끊긴 말소리는 잇고, 0.25초보다 짧은 소리는 버린다.
- 없으면(녹음 없음 · 실패) 응답 지연은 판정하지 않고 나머지 유형만 판정한다.
- 녹음의 0초와 이벤트 `offsetSeconds`의 0초가 같아야 한다(통화 시작).

### `faqs` — FAQ 원문 (선택, 근거 없는 답변 판정에 필요)

```
"faqs": [{ "question": "제주나 섬 지역도 보낼 수 있나요?", "answer": "보낼 수 있지만 …" }, ...]
```

- 백엔드 FAQ 테이블(`GET /faqs`와 같은 내용)의 질문 · 답변 전부. 통화마다 같은 값이라 모델 쪽 캐시가 걸린다.
- 근거 없는 답변은 AI가 말한 **내용**이 이 원문 · 서버 결과와 맞는지로 판정한다. 없으면 AI 서버 검토 기록(`FAQ_ANSWERED`)만으로 판단해 정확도가 떨어진다.

## 응답

`200`

```
{
  "hasComplaint": true,
  "complaints": [
    { "type": "DISSATISFACTION_EXPRESSION", "evidenceText": "번호를 세 번 말하게 되자 짜증 냄",
      "offsetSeconds": 42, "utteranceOrders": [12, 13] }
  ],
  "repeatQuestionCount": 1,
  "votes": 3,
  "model": "gpt-6-luna",
  "tokens": { "input": 2700, "cached": 0, "output": 900, "reasoning": 600 }
}
```

- `complaints`는 백엔드 `CallComplaintDto` 모양이다. 최대 20건이다.
- `type`은 화면의 여섯 유형(백엔드 `CALL_COMPLAINT_TYPES`)만 나온다.
  - `INFORMATION_RECOGNITION_ERROR` · `INTENT_RECOGNITION_ERROR` · `UNSUPPORTED_ANSWER`
  - `SLOW_RESPONSE` · `INTERRUPTION` · `DISSATISFACTION_EXPRESSION`
  - 불만 표현은 원인 유형과 따로 센다(한 장면에서 정보 인식 오류 + 불만 표현 두 건이 나올 수 있음).
  - 고객 되물음은 집계하지 않는다.
- `evidenceText`는 200자 이하다. 세 자리 넘게 이어진 숫자(번호 · 금액)는 `***`로 가린다.
- 말이 없는 통화는 `hasComplaint: false` · `complaints: []` · `repeatQuestionCount: 0` · `votes: 0` · `tokens: null`이다.
- `tokens`는 이 통화에 쓴 토큰 합계다(비용 확인용). 저장하지 않아도 된다.

## 오류

| 코드 | 뜻 | 백엔드 처리 |
|---|---|---|
| 401 `UNAUTHORIZED` | 토큰 없음 · 틀림 | 설정 확인 |
| 422 | 입력 모양이 틀림, 또는 `INPUT_TOO_LONG`(대본 4만 자 넘음) | 다시 보내도 같다. '판정 안 함'으로 저장하고 넘어간다 |
| 503 `ANALYSIS_UNAVAILABLE` | 모델 장애 · 시간 초과로 판정 실패 | 나중에 다시 부른다. 3번까지 하고, 그래도 안 되면 '판정 실패'로 둔다 |

## 개인정보

- 서비스는 받은 대본 · 판정 결과를 저장하지 않는다. 로그에는 통화 번호 · 유형 · 걸린 시간만 남는다.
- 모델 요청은 `store=False`로 보낸다.

## 운영

- 실행: `uvicorn call_analysis.server:app --host 0.0.0.0 --port 8090` (`ai/` 폴더). AI 서버 이미지에는 들어가지 않는다 — 따로 띄우거나 백엔드로 옮긴다.
- 환경 변수:
  - `CALL_ANALYSIS_TOKEN` (필수)
  - `CALL_ANALYSIS_OPENAI_API_KEY` (필수, 전용 키)
  - `CALL_ANALYSIS_CONCURRENCY` (기본 2)
- 상태 확인: `GET /health` → `{"ok": true}`
- 비용 · 시간: 통화당 약 4~5원 · 30초 안팎(gpt-6-luna medium, 3판 다수결 + 장면 확인, 11/06 측정).
- 실서버 시험: `python -m call_analysis.try_live 10` (try_live.py 맨 위 설명). 관리자 읽기 API로 실제 통화 · 녹음 · FAQ를 읽어 이 서비스로 보내고, 번호 · 유형 · 토큰만 찍는다.
