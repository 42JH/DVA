# LIVE-1 위임 대기 발화 조사

작성일: 2026-11-05. 대상: develop-ai 2ac6717의 실행 코드. 구현 변경 없음.

## 잠정 결론

BACKEND 처리 중 LIVE-1이 짧게 말하고 결과 도착 후 다시 안내하는 현상은, 현재 지시문이 요구하는 대기 안내와 비동기 Responses 위임 결과 안내가 이어지는 것으로 설명할 수 있다. 안내가 무관한 내용이거나 중간에 잘리는 원인은 별도 확인이 필요하다. 최신 문제 통화의 실제 오디오·이벤트를 확보하지 못했으므로 특정 통화의 원인을 확정하지 않는다.

## 코드에서 확인한 사실

- `app/calls/service.py:124` session_config는 gpt-live-1과 Responses delegation을 사용한다. BACKEND는 설정된 모델, priority, low verbosity로 별도 실행된다.
- `app/policy/render.py:52`는 결과 도착 전 짧은 대기 안내만 하도록 명시한다. BE 페르소나 사용 여부와 관계없이 공통 정책에 포함된다.
- `policy/persona_default.md:27`은 대기 문장들을 적절히 섞어 한 문장으로 말하도록 한다. 단, BE ACTIVE promptText가 있으면 이 기본 페르소나는 대체되므로 운영에 동일 문구가 적용됐다고 단정할 수 없다.
- `policy/backend_rules.md:7`은 도구 결과에 근거해 LIVE가 말할 내용을 한두 문장으로 반환하도록 한다.
- `app/calls/live.py:519` on_delegation은 통계·사건 기록을 한다. 이 시점에 대기 안내를 직접 송신하거나 LIVE 발화를 억제하지 않는다.
- `app/calls/live.py:584` 부근에서 function_call_output을 전달하고, resume에서 response.create로 BACKEND를 재개한다. response.create는 LIVE에게 직접 말하라는 명령이 아니다.
- 일반 함수 결과 경로는 N2 commentary로 같은 결과를 별도 전송하지 않는다. 선택형 확인 결과·인사·전환 등은 별도 N2 경로를 사용하며, 고위험 결과 오안내 감지는 N3 instructions 경로를 사용한다. 실제 문제 구간에 이 경로가 겹쳤는지는 로그로 확인해야 한다.
- N2의 _wait_quiet은 명시적인 서버 알림 경로에 적용된다. LIVE가 자율적으로 말하는 대기 안내나 Responses 결과 반영 전체를 제어하는 장치는 아니다.

## 과거 실험 기록과 현재 증거의 한계

`docs/spikes/s0-RESULTS.md:18,53,54,80`에 위임 시작 직후 자율 대기 멘트, 도구 결과 전 확인 단정, 대기 안내에서 다음 질문까지 진행한 사례가 기록돼 있다. 같은 문서의 priority 실험은 결과 발화 지연 감소를 기록하지만 현재 운영 성능의 증거는 아니다. 해당 스파이크 원시 로그와 최신 ai/logs/calls 기록은 현재 작업 폴더에서 찾지 못했다. 이번 조사에서 실통화·유료 모델 호출은 실행하지 않았다.

## 공식 문서 확인

- https://developers.openai.com/api/docs/guides/live-prompting : 위임 중 요청을 확인하는 발화를 프롬프트로 유도할 수 있으며, 업무 결과는 BACKEND 결과를 기다리도록 안내한다.
- https://developers.openai.com/api/docs/guides/live-delegation : GPT-Live는 BACKEND 작업과 동시에 말할 수 있다. Responses 함수 결과를 넣은 뒤 response.create로 계속 진행해야 한다.
- 같은 문서의 `Suppress automatic acknowledgments while tools run`은 **client delegation**에서 acknowledgement_delay_ms와 해당 delegation ID의 thinking.append를 사용하는 방법이다. 현재 Responses 방식에 그대로 적용 가능한 해결책으로 취급하지 않는다. 억제해도 이미 생성된 오디오나 독립 발화까지 막지 못한다고 명시돼 있다.
- 설치된 SDK의 ClientDelegationParam에는 type만 있고 acknowledgement_delay_ms는 없다. 현재 공식 문서와 설치 SDK 사이에 차이가 있으므로 사용 전 버전·API 지원 확인이 필요하다.

## 다음 검증 계획

1. 문제 통화 한 건의 실제 오디오, 통화 시작 시 적용된 LIVE 지시문과 페르소나 버전, 위임 BACKEND 설정을 확보한다. 비밀값·고객 정보는 분석 자료에서 보호한다.
2. 고객 발화 끝, delegation.created, LIVE 출력 전사, 함수 도착, 도구 완료, response.create, BACKEND completed, N2/N3를 같은 시간축으로 대조한다. 서버 전사 수신 시각은 실제 재생 시각과 다를 수 있다.
3. 첫 짧은 발화가 대기 문장인지, 결과를 먼저 단정하는지, 다음 질문인지 구분한다. 결과 도착과 문장 중단의 상관관계를 오디오로 확인한다.
4. 별도 시험 환경에서 현재 지시문과 대기 안내를 1회로 제한하는 지시문을 비교한다. 운영 BE ACTIVE 페르소나가 기본값을 덮어쓰는지 함께 검사한다. 구현은 별도 요청 후 진행한다.
5. 첫 소리까지의 시간과 첫 유효 결과까지의 시간을 따로 측정한다. 짧은 맞장구가 나왔다고 실제 처리 응답이 빨라졌다고 판단하지 않는다.

현재 단계에서 프롬프트 교체·위임 모드 변경·response.create 제거는 수행하지 않는다.
