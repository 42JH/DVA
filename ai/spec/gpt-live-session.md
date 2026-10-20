# GPT-Live 세션 설정 (`config/live.toml`)

- `gpt-live-1` 세션에 보낼 수 있는 **모든 파라미터**를 여기서 설정한다. 키 이름과 구조는 API의 SessionConfig와 똑같이 둔다(코드에서 키를 바꿔 끼우지 않는다). 각 키 위에 주석으로 허용값·기본값·한도·통화 중 변경 가능 여부를 적고, 기본값을 쓰는 항목은 주석 처리해 둔다.
- 통화가 올 때마다(accept 직전) 읽는다. 고치면 다음 통화부터 반영된다.
- 서버가 바꿔 넣는 것만 예외: `instructions_file`(파일 내용을 `instructions`로), 함수 도구는 이름만 적으면 코드의 설명·인수 스키마를 채움, 지시문 끝에 통화 정보(발신번호·등록 고객) 덧붙임.
- 잘못된 설정(파일 없음·문법 오류·없는 함수 도구·`delegation.type`이 `responses`가 아님·SDK `SessionConfig` 형식 오류)은 그 통화를 reject하고 로그를 남긴다. 함수 도구 이름은 기동 시에도 검사한다.
- 지시문 파일(`instructions_file`, `delegation.responses.instructions_file`)은 `prompts/` 기준 파일 이름. 구현: `app/live_session.py`.

설정 가능한 파라미터(공식 레퍼런스 기준):

| 키 | 값 | 기본·한도 | 통화 중 변경 |
|---|---|---|---|
| `model` | `"gpt-live-1"` (필수) | | 불가 |
| `instructions` | 문자열 | 최대 16,384토큰 | 불가 |
| `input[]` | 시작 전 메시지: `type="message"`, `role` = developer·user·assistant, `content`에 텍스트 하나(developer·user는 `input_text`, assistant는 `output_text`/`text`), 선택 `id`, `status`(completed·incomplete) | 최대 128개, 8,192토큰 | 불가 |
| `audio.output.voice` | 내장 31개: alloy ash ballad beacon bossa brise cedar cinder coral delta echo flitz gleam harema juni marin meridian nira noeul nuri quartz ripple sage shida shimmer sillage stone tempo verse vesper willow, 또는 `{ id = "voice_..." }`(권한 필요) | `marin` | 불가 |
| `audio.format` | `audio/pcm`(16000·24000), `audio/pcmu`·`audio/pcma`(8000) | **WebSocket 전용. SIP는 협상하므로 넣지 않는다** | 불가 |
| `store` | bool | `false`(개인정보라 끔). 켜면 녹음 30일 보관 | 불가 |
| `delegation.type` | `client` · `responses` · `decisions` | 이 서버는 `responses`만 | 불가 |
| `delegation.responses.model` | 백엔드 Responses 모델 | 필수. 위임에서 쓸 수 있는 모델 목록은 **미확인**(지금 `gpt-5.4-mini`) | 가능 |
| `delegation.responses.instructions` | 문자열 | | 가능 |
| `delegation.responses.tools` | 도구 목록: SDK 3.35.1 타입은 `function`·`web_search`만 받는다(문서의 다른 종류는 미확인) | 이 서버가 실행하는 것은 function뿐 | 가능 |
| `delegation.responses.tool_choice` | `auto`·`none`·`required`, 특정 도구 `{type="function", name}`·`{type="mcp", name, server_label}` (SDK 3.35.1 기준. `allowed_tools`는 SDK 타입에 없음) | | 가능 |
| `delegation.responses.parallel_tool_calls` | bool | `false` 권장 | 가능 |
| `delegation.responses.max_output_tokens` | 정수 | | 가능 |
| `delegation.responses.service_tier` | auto·default·flex·priority·ultrafast·fast_tier_temp_pilot | | 가능 |
| `delegation.responses.reasoning.effort` | none·minimal·low·medium·high·xhigh(모델마다 다름) | 높을수록 도구 결과가 늦음, `low` 권장 | 가능 |
| `delegation.responses.reasoning.summary` | concise·detailed·auto | | 가능 |
| `delegation.responses.text.verbosity` | low·medium·high(백엔드 글 길이, 음성과 무관) | | 가능 |
| `delegation.decisions` | `model`, `questions[]`(predicate·choice·score) | decisions 위임용. 이 서버는 안 씀(주석으로만) | 가능 |
| `triggers[]` | `{type="decisions", event_type = input/output_transcript.delta, decisions}` | 이벤트 종류당 1개 | 가능 |
| `client.data_channel.*` | 브라우저 WebRTC 데이터 채널 권한 | **SIP에는 해당 없음**(주석으로만) | 불가 |

- 없는 것: VAD·턴 감지, temperature 등 샘플링, 말 속도·언어 설정, 세션 최대 시간·유휴 타임아웃 값. 말 끝 판단·끼어들기는 모델이 한다.
- 통화 중 변경은 `session.update`로 `delegation`(같은 type 안에서)과 `triggers`만 된다. 나머지는 `immutable_field_update` 오류.
