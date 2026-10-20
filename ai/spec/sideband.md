# sideband에서의 GPT-Live 동작

- 함수 호출: sideband의 `response.event` 안에 중첩된 백엔드 이벤트를 본다. **`response.output_item.done`(type `function_call`)에서만 실행**한다(인수 완료 이벤트엔 name·call_id가 없음). 결과는 `conn.response.item.create(function_call_output)` 후 **반드시 `conn.response.create()`**를 보낸다. 안 보내면 백엔드가 멈춘다. 오류나 없는 도구여도 결과는 꼭 돌려준다.
- 관제 표시용: `response.output_item.added`(호출 시작), `response.function_call_arguments.delta`(인수 작성 중), `session.delegation.created`, `error`, `session.usage.updated`.
- 음성 모델에 조용히 맥락 주기: `conn.session.thinking.append(content, delegation_id=None)`(Responses 위임에서는 `delegation_id`가 null이어야 함). **500토큰 한도**라 길이 상한을 테스트로 지킨다. `commentary.append`(말할 내용), `instructions.append`(압축 뒤에도 유지)도 같은 한도.
- 받아쓰기: `session.input_transcript.delta` / `session.output_transcript.delta`. **문장 경계·item ID가 없다**(대신 `start_ms`·`end_ms`가 있다). 말하는 쪽의 마지막 말풍선이 맨 끝이거나, 그 말풍선의 끝과 새 조각의 간격이 서버 설정 `monitor.bubble_gap_ms` 안이면 이어 붙인다(겹쳐 말해도 쪼개지지 않게). 아니면 새 말풍선.
- 먼저 인사: 세션 `input`에 developer 메시지("전화가 방금 연결됐습니다. 지금 바로 인사하세요.")를 넣는다.
- 통화 종료: `end_call` 직후 끊으면 마무리 인사가 잘린다. **요청 뒤에 음성 출력(`session.output_audio.delta`·`output_transcript.delta`)이 한 번 이상 나오고** 서버 설정의 시간만큼 멈추면(최대 대기 있음) hangup한다. 상담원 전환(`transfer_to_agent`)도 같은 기준으로 기다린 뒤 refer한다.
- 함수 호출은 통화별 작업으로 돌려 이벤트 받기를 막지 않고, 통화별 잠금(FIFO)으로 순서를 지킨다. 구현: `app/sideband.py`.
