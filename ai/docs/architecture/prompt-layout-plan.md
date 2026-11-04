# Live 지시문 배치 계획 v2 — 업무 규약 .md + BE 페르소나, 코드에는 문장 없음

상태: 계획(승인 전). 2026-11-04 사용자 결정으로 v1(코드 고정·우선순위 문장)을 대체한다.

## 결정(사용자)
- 업무 규약 프롬프트(.md)와 페르소나 프롬프트를 **분리**한다.
- **페르소나만 BE에서 받는다**(`promptText`).
- 서버 코드는 프롬프트 문장을 **강제·고정하지 않는다**. 업무 규약 .md는 운영 중 수정하지 않으므로 사실상 규약은 고정된다.

## 1. 목표 구조

```
Live instructions = [페르소나] + [업무 규약] + [통화 정보]

[페르소나]   BE ACTIVE promptText          ← 관리자가 수정(다음 통화부터)
             없으면 policy/persona_default.md
[업무 규약]   policy/business_rules.md       ← 저장소 파일. 배포로만 바뀜
[통화 정보]   서버가 채우는 값(데이터)          ← 전화 받은 시각, 등록 여부, 성함, 기본 출발지
```

- 서버가 하는 일은 **두 파일을 이어 붙이고 통화 정보 값을 넣는 것뿐**이다. 문장을 만들거나 덧붙이지 않는다.
- 지금 코드가 만드는 문장은 모두 `business_rules.md`로 옮긴다(§2). 우선순위 문장("충돌 시 페르소나 우선")도 삭제 — 필요하면 규약 .md 안에 적는다.
- BE 계약: 페르소나 주입 위치는 AI 재량(`ai-persona-next-call.md`). API·스키마·검증(INVALID_CONFIG 등)·적용 절차는 그대로.

## 2. 코드에서 빼서 파일로 옮길 문장

| 지금 위치 | 내용 | 옮길 곳 |
|---|---|---|
| `policy/default_prompt.md` | 역할·말투 | `persona_default.md` |
| 〃 | 인사·주소·전화번호·접수 안내·처리 불가·마무리 | `business_rules.md` |
| `app/policy/render.py` `render_live` | 충돌 규칙 한 줄, "# 통화 정보" 머리말 | 삭제(머리말·항목 이름은 `business_rules.md`의 틀로) |
| `app/policy/render.py` `render_policy` | 받는 순서·항목 규칙·단계 목표·위임 기준(SpawnThinking)·도구 목록·금지·읽기 규칙·서버 결과 읽는 법·다시 묻기 | `business_rules.md`(손으로 쓴 문장) |
| `policy/workflow.toml` | `goal`·`rule`·`[forbid].items`·`[speech]`·`[results]`·`[reask]` 문장 | 문장은 `business_rules.md`로. toml에는 서버가 실제로 쓰는 데이터만 남김(필드·단계 판정·확인 관문 수치·문구 검사 phrases·Decision 질문) |

**Live 외 모델 프롬프트**(`promptText`와 무관, 같은 원칙으로 파일화):
| 지금 위치 | 옮길 곳 |
|---|---|
| `render_backend` 고정 문단(Backend 모델 지시문) | `policy/backend_rules.md` |
| Decision 질문 instructions | `workflow.toml` 그대로(이미 파일) |
| 도구 설명·인자 설명 | 함수 스키마의 일부라 코드에 둔다(도구 계약). 문장만 바꿀 일이 생기면 별도 결정 |

## 3. 제시 프롬프트 나누기

| 제시 프롬프트 절 | 파일 |
|---|---|
| Identity, Personality, Speaking Style, Backchannel, Interruption, Response Boundaries(대기 문구) | **페르소나**(BE `promptText` + `persona_default.md` 기본값) |
| 인사 문구, 통화 시작, 받는 순서, 받는 말, 주소 듣기, 숫자 발화, 전화번호, 등록 고객과 주소록, 수거, 결제 안내, 접수 안내, 백엔드에 맡기는 일, 조회·취소, 상담원 연결, 마무리, 검색 자료로 답하기 | **`business_rules.md`** |
| + 현재 코드가 주던 서버 연동 문장: 서버 결과 키의 뜻(`call_started`·`closing`·`order`·`confirmation`·`submitted`·`unverified`·`more_parcels`·`missing`·`readback`·`needs` …), 도구 목록, 위임 기준 | **`business_rules.md`**에 함께(없으면 서버 알림을 해석하지 못한다) |

용어 통일: 제시 프롬프트의 "진행 상태" → 리빌드의 "서버 결과(`[서버 결과] {…}`·도구 결과)". "통화 정보의 첫 질문" → "서버 결과의 missing 첫 항목".

## 4. 업무 규약 내용 결정 필요(서버 동작과 다른 문장)

| # | 제시 프롬프트 | 현재 서버 | 권장 |
|---|---|---|---|
| a | 수거 일시 조정, 9~17시 | 수거 일시 안 받음(결정 1-b) | 서버 유지 → "결제 완료 후 1시간 안 방문, 시각 약속 안 함" |
| b | 확인 질문의 답도 위임 | 고르는 답은 서버 Decision, 위임은 값 추출만 | 서버 방식 유지 |
| c | 번호 받은 직후 되읽지 않음 | 새 번호는 바로 끊어 읽어 확인(`phones_to_read`) | 선택 |
| d | 번호는 틀린 부분만 고침 | 전체 다시 받음 | 전체 다시 받기 |
| e | `transferCall`·`create_callback_request`·근무 시간 | 도구 없음, 상담원 미설정 | "담당자가 확인 후 연락" |
| f | 인사에 `{등록된 출발 주소지}` | 통화 정보에 없음 | 통화 정보에 기본 출발지(도로명까지) 추가 |
| g | 출발지 바뀌면 접수 후 주소록 수정 | 신규 등록 때만 PIN 저장 | BE 계약 확인 전까지 제외 |
| h | 같은 질문 3회 실패 → 이관, 해결 시 초기화 | `reask` 3회 → 다른 방법 → 상담원 제안 | 서버 규칙으로 문장 통일 |
| i | 주소 맞장구 되풀이(페르소나) | 주소 다시 말하지 않음 | 선택(페르소나 절 vs 업무 규약 충돌) |

## 5. 손으로 쓴 규약과 서버의 어긋남 막기
코드가 문장을 만들지 않으면 `business_rules.md`와 서버 동작(`workflow.toml`의 단계·필드, 서버 결과 키)이 따로 바뀔 수 있다. 문장을 강제하지 않고 **테스트로만** 확인한다.
- 서버가 보내는 결과 키(`[results]`에 있던 키 전부)가 `business_rules.md`에 설명돼 있는지
- 받는 순서의 항목 이름이 `workflow.toml` 단계·필드 순서와 같은지
- 도구 이름이 `function_specs()`와 같은지
- 페르소나 없음 → `persona_default.md`, 있음 → `promptText`가 맨 앞이고 규약 .md 전체가 항상 들어가는지

## 6. 구현 단계(승인 후)
1. `policy/persona_default.md`, `policy/business_rules.md`, `policy/backend_rules.md` 작성(§3·§4 결정 반영). `default_prompt.md` 삭제.
2. `render_live` → 파일 이어 붙이기 + 통화 정보 값. `render_policy` 삭제. `render_backend` → 파일 읽기.
3. `workflow.toml`에서 문장 항목 정리(데이터만 남김). 모델 스키마(`app/policy/model.py`) 맞춤.
4. 통화 정보에 기본 출발지(§4-f).
5. §5 테스트 + 기존 테스트 갱신 → worklog·커밋 → 로컬 실통화 → 새 MR.

## 7. 운영
- BE 관리자 페르소나는 **페르소나 절만** 남긴다(지금 ACTIVE에 전체 프롬프트가 있으면 규약이 두 번 들어간다).
- 규약 .md가 길어지므로 첫 발화 지연을 실통화로 잰다(P50·P95).
