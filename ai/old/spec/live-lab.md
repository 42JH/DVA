# Live-1 웹 음성/RAG 실험

2026-10-27 사용자 요청. 실제 전화 대신 브라우저 마이크로 GPT-Live-1과 대화하고, 전사·근거·시간을 추적한다. 독립 개발 서버이며 현재 SIP 통합은 별도의 client 위임 경로다(spec/rag.md).

## 목적과 전달 경계

기존 텍스트 평가는 백엔드 LLM 검색 결정→RAG→백엔드 LLM 최종 답변의 두 호출을 사용했다. 새 경로는 Live-1→client 위임→애플리케이션의 백엔드 Responses 한 번(검색 도구 선택)→실제 RAG→Live-1 직접 근거 전달→Live-1 발화다. 반환된 검색 근거를 백엔드 모델 입력으로 돌리지 않는다.

OpenAI 관리 Responses 위임에서는 모든 function_call_output을 돌려주고 response.create로 백엔드를 이어야 한다. 이 절차에서 일부 결과만 가로채고 백엔드를 미완료 상태로 두는 구현을 하지 않는다. 이번 실험은 세션 생성부터 delegation.type=client를 사용한다. backend model은 애플리케이션이 한 번 호출하고 이후에는 Live의 thinking/commentary append만 사용한다. 운영 세션 live.toml의 delegation.type은 바꾸지 않는다.

클라이언트 위임 이벤트에는 ID·offset만 있고 요청문은 없다. 서버가 input/output transcript 조각을 공백 그대로 모아 최근 대화 기록을 만든다. 모델이 검색어를 선택하되 없는 고객 조건은 추가하지 않도록 지시한다. 전사는 turn 완료 신호가 아니므로, 아주 빠른 위임·고객 정정·겹쳐 말하기에서 전사 수신 시점이 충분했는지 기록과 함께 수동 검증해야 한다.

## 코드와 실행 경계

- app/live_lab/config.py: config/live-lab.toml 검증. 운영 설정과 분리.
- app/live_lab/bridge.py: 위임당 Responses 1회, 검색 결과 검증·직접 전달, 원문 분할, 전사와 시간 기록.
- app/live_lab/app.py: 인증·소유권·동일 출처·세션 생성/정리·SSE·내보내기.
- app/live_lab/static/: 마이크 WebRTC, 전사·Top3·타임라인, 브라우저 오디오 감지 UI.
- scripts/run_live_lab.py: 실행 시 기존 인증 환경 로드, RAG 준비·재사용, 로컬 바인딩.
- scripts/remote_text_search.py: 기본 운영 검색 어댑터. 동일 RagService와 외부 /rerank를 사용한다. scripts/local_text_search.py는 과거 로컬 CUDA 재현용이며 취소 후 스레드 통신 교차를 막는 잠금을 유지한다.

이 화면은 주문 도구를 노출하지 않고 backend API·PBX 웹훅도 필요하지 않다. 실제 전화의 auto 도구 선택/주문 회귀를 대신하지 않는다. 외부 GPU 연결 코드와 실제 서버 연결 검증은 구분한다.

## 브라우저 연결

브라우저가 RTCPeerConnection의 SDP offer를 서버에 보낸다. 서버는 프로젝트 키로 client.live.create(session,transport={type:webrtc,sdp})를 호출하고 session.id/transport.sdp만 반환한다. 키는 브라우저에 보내지 않는다. 브라우저가 answer를 적용하고 오디오는 WebRTC로 OpenAI와 직접 교환한다. 서버는 해당 opaque session ID로 sideband를 붙인다. HTTP 생성이 세션을 시작하므로 데이터 채널에서 session.start를 다시 보내지 않는다.

HTTP Basic은 기존 MONITOR_USER/MONITOR_PASSWORD를 재사용한다. 페이지에서 HttpOnly/SameSite=strict 소유권 쿠키를 발급한다. 생성·종료·측정 POST/DELETE는 같은 Origin만 받고, 조회·SSE·export도 같은 쿠키의 세션만 허용한다. host 설정은 localhost/127.0.0.1만 허용하고 세션 수와 수명을 제한한다. 설정·검증은 config/live-lab.toml을 따른다. 다른 사람에게 공개하려면 HTTPS·서비스 사용자 인증·배포용 GPU 어댑터를 별도 설계해야 한다.

store=false, 오디오 바이트는 메모리 기록/SSE/export에 넣지 않는다. 전사·검색 근거·타임라인은 제한된 세션 메모리에 있고 사용자가 JSON을 내보낼 때만 내려받는다. 종료된 세션은 보관시간 후 다음 세션 생성 시 정리한다. 인증 쿠키·프로젝트 키·SDP는 export하지 않는다.

## Live로 근거 전달

원래 Top3 본문·제목·질문을 모두 보존하며 내부 점수와 긴 청크 ID는 서버의 추적 기록에만 둔다. 자료를 추가 모델로 요약하지 않는다. 한 append는 공식 한도 500토큰 이내여야 하므로, Unicode 문자 경계를 유지하며 o200k_base/cl100k_base 양쪽 카운트로 보수적으로 나눈다. 기본 본문 조각350토큰, 설정 상한400토큰으로 헤더 여유를 둔다. 정확한 Live 내부 tokenizer와 같다는 보장은 아니므로 실제 한도 오류도 처리한다.

각 조각은 해당 client delegation ID로 session.thinking.append에 보내고, client_event_id에 대응하는 thinking.appended를 기다린다. 모든 조각 수신 확인 후 session.commentary.append로 'RAG 자료 전달 완료'를 알린다. Live 지침에는 모든 자료가 올 때까지 일부 근거로 정책 답변을 확정하지 않도록 둔다. 다만 공식 문서상 acknowledgment는 발화나 실제 근거 사용의 보장이 아니므로 내용은 실제 전사로 검토한다. 분할·수신 확인이 주는 지연도 따로 측정하며 빨라졌다고 미리 단정하지 않는다.

새 위임이 시작되면 이전 작업을 취소하고 latest_delegation ID를 검사해 늦은 결과를 발화하지 않는다. 검색·백엔드·append timeout을 구분해 기록한다. 실패 시 불완전한 자료를 성공으로 표시하지 않고 확인이 필요하다는 안내를 Live에 보낸다. 종료 시 작업과 sideband를 정리하고 Live session.close와 브라우저 미디어 정리를 수행한다.

## 시간과 전사 해석

| 값 | 시계·범위 | 의미/제약 |
| --- | --- | --- |
| backend_seconds | 서버 monotonic | 검색 도구 선택용 Responses API 한 번. 네트워크·대기·연산 포함 |
| search_seconds/search_timings | 서버 monotonic | 실제 검색 도구 전체 및 임베딩/DB/BM25/RRF/Qwen |
| context_delivery_seconds | 서버 monotonic | 조각 전송부터 모든 context ACK까지 |
| first_audio/transcript_after_handoff_ms | 서버 monotonic | 완료 알림 이후 첫 반사 오디오/전사 수신. 오래된 타임라인 프레임은 제외. 정답 안내 시작 여부는 별도 검토 |
| input_end_to_audio/transcript_timeline_ms | Live start/end_ms | 고객 마지막 전사 끝부터 근거 이후 첫 출력 타임라인 시작까지의 추정 간격. 정확한 발화 종료 신호가 아님 |
| browser_measurement | 브라우저 performance.now | 로컬 RMS로 감지한 마이크 침묵/출력 에너지. 임계값·잡음·SSE 지연 영향. 실제 정답 발화 시작 보장 아님 |

서버 시각, Live 타임라인, 브라우저 시각을 서로 직접 빼지 않는다. 자동 맞장구는 근거 기반 답변과 다를 수 있다. UI/보고서에서 '첫 음성'을 정답 완료 시간으로 부르지 않는다. 발화 전사는 실제 조각을 보존하며 응답 완료 이벤트가 없어서 말풍선은 시간 간격으로 묶는다. export의 원래 조각·시각으로 후속 평가에 사용한다. 기준 답변이 없는 자유 음성 대화에서 Ragas를 자동 실행하지 않는다.

## 검증 범위

가짜 클라이언트로 단일 backend 호출, 원문·표·중괄호·토큰 한도, stale 결과 차단, 세션 격리, 시간 시계 구분, timeout, 인증·Origin·소유권·상한·종료와 검색 스레드 취소를 시험한다. 브라우저 초기 화면 검사는 마이크와 유료 Live 세션을 시작하지 않는다. 실제 브라우저 발화 내용·오디오 왕복·지연 개선은 사용자가 페이지에서 연결해 검증한다. 별도 자동 음성 실험은 다음 절의 합성 질문 방식으로 수행한다.

## 고정 FAQ 음성 평가

`scripts/run_live_rag_eval.py`는 기존 faq_v1의 검토된95문항을 합성 한국어 음성으로 만들고, 문항마다 새 GPT-Live-1 primary WebSocket 세션에 PCM16/24kHz를 실시간으로 보낸다. 실제 마이크와 전화는 사용하지 않는다. 웹 화면과 같은 `DirectRagBridge.delegate`와 `LocalTextSearch`를 사용해 백엔드1회→실제 검색→Live 직접 전달을 검증한다. WebRTC와 다른 전송이므로 브라우저 체감 지연을 대체하지 않는다.

기준 답변·정답 근거·필수 사실은 생성 모델에 주지 않는다. 생성 실행의 기록에는 BM25·dense 전체 순위, RRF Top5, 리랭킹 순위와 실제 전달된 Top3, Live 입력/출력 전사 및 단계 시간을 보존한다. 실패한 전달은 실제 문맥으로 계산하지 않는다. 위임이 없으면 검색 지표는0이며 답변이 옳았는지는 별도 채점한다. 여러 위임의 근거는 모두 기록하고 기본 검색 점수는 첫 검색 기준이다.

완료 이벤트가 없어 입력 음성 종료, 위임 작업 종료, 마지막 전사·오디오 수신 및 PCM 길이로 추정한 가상 재생 끝 뒤 기본6초의 침묵으로 관찰을 종료한다. 이 침묵은 별도 관찰 종료 시간으로 표시한다. 최대75초 timeout, 실패 시 새 문항 실행을 멈추며 이미 진행 중인 최대3건만 정리한다. 재실행은 동일 입력/프롬프트/설정 해시를 확인해 성공 문항을 건너뛴다. 이전 실패 시도는 previous_attempts에 보존하고 최신 시도가 records에 남는다. 변동성 평가에는 새 실행 폴더를 사용한다.

실제 첫 전체 실행에서 한 질문의 합성 음성이0.3초로 생성되어 전사·위임 없이 timeout이 발생했다. 이를 RAG 검색 실패로 단정하지 않고 입력 생성 문제로 분리했다. 이후 합성 입력은 PCM16 정렬·1~60초 길이·비무음 검사를 통과해야 전송하며 비정상 캐시 파일과 이전 실패 시도는 보존한다. 이 기본 검사는 실제 발음과 질문 내용의 일치를 보장하지 않는다.

첫 음성 패킷·첫 전사·근거 전달 후 음성 패킷·마지막 출력·관찰 종료를 구분한다. primary WebSocket 출력 오디오에는 공식 start/end가 없으므로 수신 시각으로만 측정하며 스피커 재생을 측정했다고 하지 않는다. 근거 알림 직후 오디오는 앞선 맞장구의 잔여 패킷일 수도 있다. 따라서 이를 정답 안내 시작으로 확정하지 않는다. 기존 텍스트 평가의 total_seconds와 혼동하지 않도록 음성 실행은 해당 필드를 null로 남긴다.

생성 후 기존 `scripts/score_text_rag.py`가 실제 Live 발화 전사 전체와 실제 전달 문맥으로 Ragas 네 지표를 계산한다. 맞장구·불필요한 안내도 전사에서 제거하지 않는다. `scripts/summarize_live_rag.py`는 시간 표본 수/평균/중앙값/p95, 검색 위임 없음·Top3 누락·낮은 자동 점수 등의 검토 대상을 별도 파일로 만든다. 합성 질문 음성만 Git 제외 경로에 캐시하고 고객 마이크·응답 오디오를 저장하지 않는다. 단위 테스트는 모두 가짜 입력으로 수행하며 유료 실제 실험은 사용자가 요청한 별도 실행이다.

## 공식 확인 근거

- [GPT-Live 위임 및 도구](https://developers.openai.com/api/docs/guides/live-delegation): client 위임의 직접 결과 반환과 Responses 위임의 계속 처리.
- [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc): SDP, live.create, oai-events.
- [세션 관리](https://developers.openai.com/api/docs/guides/live-conversations): 500토큰 append, context ACK 한계, 전사 시간.
- [sideband](https://developers.openai.com/api/docs/guides/voice-server-controls): 같은 session ID로 서버 연결.
- 설치된 OpenAI3.35.1의 AsyncLive.create, sideband.session.thinking/commentary.append, session.close, LiveCreateResponse와 이벤트 타입으로 재확인했다.
- [GPT-Live evaluation guide](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation): 합성 질문 음성을 사용하는 CRAWL 평가와 침묵 기반 종료 추정.
- [WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets), [Text to speech](https://developers.openai.com/api/docs/guides/text-to-speech): primary 세션 시작, 연속 PCM 스트림 및 합성 음성 형식.
