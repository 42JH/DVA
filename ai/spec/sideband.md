# sideband에서의 GPT-Live 동작

- 함수 호출: sideband의 `response.event` 안에 중첩된 백엔드 이벤트를 본다. **`response.output_item.done`(type `function_call`)에서만 실행**한다(인수 완료 이벤트엔 name·call_id가 없음). 결과는 `conn.response.item.create(function_call_output)` 후 **반드시 `conn.response.create()`**를 보낸다. 안 보내면 백엔드가 멈춘다. 오류나 없는 도구여도 결과는 꼭 돌려준다.
- 관제 표시용: `response.output_item.added`(호출 시작), `response.function_call_arguments.delta`(인수 작성 중), `session.delegation.created`, `error`, `session.usage.updated`.
- 음성 모델에 조용히 맥락 주기: `conn.session.thinking.append(content, delegation_id=None)`(Responses 위임에서는 `delegation_id`가 null이어야 함). **500토큰 한도**라 길이 상한을 테스트로 지킨다. `commentary.append`(말할 내용), `instructions.append`(압축 뒤에도 유지)도 같은 한도.
- **고객 답 판별**(`app/listener.py`): 고객 받아쓰기를 이번 단계에서 아직 판별하지 않은 말에 이어 붙이고, `listener.pause_ms` 동안 새 조각이 없으면 `responses.create`(작은 모델, 정해진 JSON 스키마, `store=false`)로 "이 단계의 답 + 끼어드는 용건"을 판별한다. 상담원의 직전 말을 같이 넘긴다. 판별 결과로 상태가 바뀌면 바로 `thinking.append`. 판별 실패·시간 초과는 상태를 바꾸지 않고 관제에 오류로 남긴다. 판별 기록은 관제 도구 패널에 `listener`로 보인다.
- GPT-Live 세션의 `triggers`(type `decisions`)·Decision API는 SDK 타입에는 있으나 공개 문서에 없어 **미확인**이라 쓰지 않는다. 확인되면 판별 수단으로 바꿀 수 있다.
- 받아쓰기: `session.input_transcript.delta` / `session.output_transcript.delta`. **문장 경계·item ID가 없다**(대신 `start_ms`·`end_ms`가 있다). 말하는 쪽의 마지막 말풍선이 맨 끝이거나, 그 말풍선의 끝과 새 조각의 간격이 서버 설정 `monitor.bubble_gap_ms` 안이면 이어 붙인다(겹쳐 말해도 쪼개지지 않게). 아니면 새 말풍선.
- 먼저 인사: 세션 `input`에 developer 메시지("전화가 방금 연결됐습니다. 지금 바로 인사하세요.")를 넣는다.
- 통화 종료: 종료 요청·"더 용건 없음"을 판별한 직후 끊으면 마무리 인사가 잘린다. **요청 뒤에 음성 출력(`session.output_audio.delta`·`output_transcript.delta`)이 한 번 이상 나오고** 서버 설정의 시간만큼 멈추면(최대 대기 있음) hangup한다. 상담원 연결 동의를 판별했을 때도 같은 기준으로 기다린 뒤 refer한다.
- 함수 호출은 통화별 작업으로 돌려 이벤트 받기를 막지 않고, 통화별 잠금(FIFO)으로 순서를 지킨다. 구현: `app/sideband.py`.
