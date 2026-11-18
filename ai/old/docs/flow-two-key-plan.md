# 통화 흐름 정리 계획: 순서는 지시문, 해석은 Live-1, 확인은 두 열쇠

2026-11-02 사용자 결정. 기준: develop-ai `dac4bef`(내용은 `30869a8`과 같음). 아직 구현하지 않았다.

## 왜

- 같은 고객 말을 두 곳이 서로 다른 맥락으로 해석한다. Live-1은 자기가 실제로 한 말을 기준으로, 서버 판별기는 서버가 정해 둔 질문(`Call.heard_asked`)을 기준으로 본다. Live-1의 직전 발화는 예측할 수 없다.
- 그래서 Live-1이 확인 질문 뒤에 자기 질문("더 궁금하신 점 있으세요?")을 하고 고객이 "네"라고 하면, 서버가 그 말을 확인 질문의 동의로 받는다. 취소와 택배 담기 모두 재현된다(`tests/test_sideband.py`의 `KNOWN_DESYNC` 두 개).
- 지금까지는 어긋남이 드러날 때마다 장치(`heard_asked`, `[core]`·`prompt_heard`, `reask` 한 번, 위임 안전망의 답 경로)를 덧붙였다. 이 장치들은 증상만 막고 원인은 그대로 남긴다.

## 결정

| 항목 | 방식 |
|---|---|
| 필드 순서 | `prompts/voice.md`에 고정 목록으로 둔다(`spec/flow.md` "빠진 항목"의 순서). LangGraph(`ORDER`)는 빠진 항목과 다음 질문을 계산해 진행 상태로 알려 준다. |
| 서버 강제 | 넘어가지 말아야 할 곳만 강제한다. 빠진 항목이 있으면 `A_CONFIRM`으로 가지 않고(`order_complete`), 주소DB에서 못 찾은 주소는 기록하지 않는다(`record_order`). 둘 다 지금 있다. |
| 고객 말 해석 | Live-1이 한다. 값은 위임해 `record_order`로 보내고, 되돌릴 수 있는 선택(제안 B4·B8·B9, HUB 용건)은 `answer` 도구로 보고한다. 서버 판별기는 쓰지 않는다. |
| 되돌릴 수 없는 확인 | **두 열쇠**: Live-1의 `answer` 보고(동의)와 서버 판별(같은 고객 말이 분명한 동의)이 **둘 다 "예"일 때만** 확정 지연에 들어간다. 다르면 아무것도 하지 않고 확인 질문을 다시 한다. 서버 판별은 질문 맥락 없이 "분명한 동의인가"만 본다. 대상: `A_CONFIRM`, `A_PAYMENT`(결제 선택), `C_CANCEL_CONFIRM`, `C_CANCEL`(재시도), `D_AGENT_OFFER`. |

## 단계

1. **(완료, 이 브랜치) 안전 규칙 테스트.** `tests/test_flow.py`의 `Rules`가 모든 `play()` 보고마다 다음을 검사한다.
   - 빠진 항목이 있으면 `A_CONFIRM`으로 가지 않는다.
   - 택배는 동의한 만큼만, 임시 주문 그대로 담는다.
   - 취소와 상담원 연결은 동의했을 때만 한다(탈퇴 고객은 예외).
   - 접수는 한 번이다.

   담는 택배의 값을 바꾸는 변형을 넣었을 때 기존 127개는 모두 통과했고, `Rules`는 15곳에서 잡았다. 알려진 결함 두 개는 `xfail(strict=True)`로 넣었다.
2. **(완료) `voice.md` 필드 순서를 고정했다**("택배 정보 받는 순서(고정)"). 프롬프트만 바꿨다. 페르소나 v2(백엔드 ACTIVE)에도 같은 내용을 반영해야 한다(남음).
3. **(완료) 확인을 두 열쇠로 바꿨다**(`listener.consent`, `Stage.consent`, `[listener] consent_wait_sec` 5초).
   - `voice.md`·`backend.md`: 확인 질문의 답도 맡기고 `answer`로 보고한다. 단, 그 확인 질문의 답일 때만 보고한다.
   - `answer` 도구는 확인 단계에서도 허용한다. 동의는 한쪽 열쇠로만 남기고, 거절 같은 다른 답은 아무것도 하지 않는다(서버 판별이 처리).
   - 짝 맞추기는 계획의 "같은 고객 말(`heard_rev`)" 대신 **같은 단계 + 시간 창(`consent_wait_sec`)**으로 했다. Live-1 보고에는 어느 고객 말인지 알 수 있는 표시가 없다. 대신 서버가 동의가 아닌 답이나 다른 용건으로 들으면 먼저 온 보고를 버린다.
   - 짝이 오지 않거나 다르면 `watch_flow`가 `consent_retry`로 확인 질문을 다시 하게 한다. Live-1이 먼저 보고한 동안의 "다음"은 `CONSENT_WAIT`이다.
   - `KNOWN_DESYNC`의 xfail을 지웠고 두 테스트가 통과한다. 한쪽 열쇠만으로 실행되게 바꾸는 변형을 넣으면 3개가 실패하는 것을 확인했다.
   - `AGENTS.md`, `spec/flow.md`·`sideband.md`·`tools.md`·`server-config.md`, `backend.md`를 함께 고쳤다.
4. **장치와 그 테스트를 지운다.** 3이 실제 통화에서 확인된 뒤에 한다.
   - 코드: `Call.heard_asked`, `prompts/flow.toml [core]`, `listener.prompt_heard`·`covers`, `reask`·`reasked`, `Stage.unheard_ok`, 확인 단계가 아닌 곳의 판별 호출, `reportable`의 답 경로.
   - 유지: 확정 지연(`commit_delay_ms`), 판별 리비전(`heard_rev`), 값과 정정의 위임 안전망(`value`, `correction`).
   - 지울 테스트(새 구조로 옮겨 쓰지 않음):
     - `test_flow.py`: `test_unheard_yes_is_reasked_once_per_question_but_no_is_taken`, `test_heard_after_core_or_after_agent_finished`
     - `test_sideband.py`: `test_15_yes_before_core_is_not_taken_and_question_is_asked_again`, `test_unreported_answer_is_forwarded_to_backend_not_applied_by_server`, 그리고 `heard_asked`를 확인하는 판별 입력 테스트
   - 지운 뒤에도 `Rules`와 시나리오가 통과해야 한다.

## 미정·위험

- **배포 차단(2026-11-02):** 운영에서는 음성 지시문으로 `voice.md`가 아니라 백엔드 ACTIVE 페르소나의 `promptText` 전체를 쓴다(`live_session.build_session`). 그래서 2·3단계의 지시문 변경(고정 순서, 확인 답도 `answer`로 보고)이 Live-1에 닿지 않는다. 이 상태로 배포하면 Live-1이 확인 답을 보고하지 않아 모든 확인이 짝 없음으로 끝난다(접수·취소가 안 되고 확인 질문만 반복). 해결 방향은 11-01 결정(관리자는 페르소나만 수정, 업무 규칙은 저장소 한 곳)을 적용하는 것이며, 보류 중이다(사용자 결정 2026-11-02).

- **되읽기를 끝까지 듣기 전에 끼어든 "네":** Live-1이 이것도 동의로 보고하면 두 열쇠가 모두 열린다. 지금은 `prompt_heard`가 막는다. 4단계 전에 실제 통화로 Live-1의 판단을 확인한다.
- **지연:** 확정까지 백엔드 왕복(약 1~2초)을 기다린다. 확정 지연 700ms와 겹쳐 진행되지만 측정하지 않았다.
- **Live-1이 확인 답을 위임하지 않는 경우:** 3단계의 "다시 묻기"가 처리하지만 같은 질문이 반복될 수 있다. 그 빈도는 통화로 본다.
- **Jira 번호:** 지금 브랜치는 `S15P31D109-133`을 따랐다. 리팩토링을 별도 이슈로 할지는 사용자가 정한다.
- **평가 세트:** 실제 통화 받아쓰기 재생 평가 세트(개인정보 제외)가 없다. 지금은 통화 한 건이 수정 근거가 된다.
