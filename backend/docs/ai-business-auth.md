# 고객 업무 API·기업 배송지 검색 서비스 인증

2026-11-09 후속: 주문·이전 주문 주소·개인 PIN·AI FAQ 12개도 관리자 세션 또는 AI_BUSINESS_TOKEN으로 인증한다. 해당 범위의 기존 MVP 설명보다 [공용 API 인증 전환·AI/프론트 전달 명세](shared-api-auth-handoff.md)가 우선한다.

2026-11-05. 모놀리식 고객 API와 기업 배송지 검색의 익명 접근을 차단한다. 실제 운영 배포·AI 코드 변경은 별도다. 이 문서는 과거 MVP 문서의 무토큰 접근 설명보다 우선한다.

## 적용 범위

| 호출 | AI 인증 | 기존 성공 응답 |
| --- | --- | --- |
| POST /api/customers/context | 업무 Bearer. 조회와 call 등록 모두 적용 | 200 |
| POST /api/customers | 업무 Bearer | 201 |
| GET /api/customers/{id} | 업무 Bearer | 200 |
| PATCH /api/customers/{id} | 업무 Bearer. address 수정·삭제는 기존 call_session_seq도 필수 | 204 |
| GET /api/companies/search | 업무 Bearer 전용. 관리자 쿠키로 대체 불가 | 200 |

위 고객 API는 유효한 ACTIVE 관리자 세션으로도 사용할 수 있다. 관리자 쓰기에는 허용 Origin이 필요하다. 고객 목록은 계속 관리자 전용이며 AI 업무 토큰으로 조회할 수 없다. status·월결제 자격 변경도 관리자 전용이다. 고객 API의 만료·잘못된 관리자 쿠키는 AI 인증으로 대체하지 않는다. DIR-01은 쿠키와 무관하게 Bearer를 검증한다. 관리자 사원 검색은 [별도 API](../../docs/api/company-members-search.md)를 사용한다.

요청 본문·응답 봉투·고객 데이터·주소 수정의 진행 중 본인 통화 검사는 유지한다. 인증·검색 추가 자체에는 DB 변경이 없다. 함께 진행하는 기업 PIN 제거에는 [053 migration](company-pin-retirement.md)이 필요하다.

## 환경과 AI 호출

BE와 AI 서버의 비밀 환경에 같은 값을 저장한다. 32자 이상 공백 없는 무작위 ASCII 토큰이며 Bearer 접두사는 값에 넣지 않는다. 실제 토큰은 문서·Git·로그·프롬프트·프론트에 넣지 않는다.

```dotenv
AI_BUSINESS_TOKEN=<공유한 토큰 값>
```

AI 서버의 HTTP 클라이언트가 위 고객 호출과 기업 배송지 검색에 헤더를 주입한다. 모델 도구 인자로 토큰을 받지 않는다. 기업 검색 q는 NFC·공백 정리 후 1~100자다. 여러 조건을 합쳐 100자를 넘으면 짧은 조건을 다시 구성하거나 추가 질문을 하며, 임의 절단·동일한 400 재시도는 하지 않는다.

```http
POST /api/customers/context
Content-Type: application/json
Authorization: Bearer <AI_BUSINESS_TOKEN>

{"phoneNumber":"01012345678"}
```

| 상황 | 응답·처리 |
| --- | --- |
| BE 토큰 미설정 | 해당 AI 고객 호출은 503 DEPENDENCY_UNAVAILABLE. 관리자 세션은 유지 |
| 요청 토큰 누락·오류·중복 Authorization | 401 UNAUTHORIZED. 고객 서비스 실행 전 거절 |
| 유효한 AI가 관리자 전용 고객 필드 변경 | 403 FORBIDDEN |
| 정상 인증·입력 | 기존 업무 응답 유지. AI 표기는 인증 성공 후 설정 |

401은 설정 오류로 분리하고 같은 변경 요청을 무한 재전송하지 않는다. 실패 로그에는 요청 ID와 안전한 오류 정보만 남긴다. 기존 AI_PERSONA_TOKEN·AI_INSIGHTS_TOKEN·AI_FAQ_TOKEN·PBX 토큰은 각 용도를 유지하며 업무 토큰으로 덮어쓰지 않는다.

## 전환 순서

1. 운영 BE `/home/ubuntu/dva-deploy/shared/.env`와 AI 실행 환경의 업무 토큰 값을 맞춘다. BE production은 env 파일을 직접 읽지 않고 Compose가 주입한 환경을 읽는다. 로컬 개발은 backend/.env.development 또는 실행 환경을 사용한다.
2. BE 환경 검증·가드와 Compose 주입을 포함한 새 이미지를 준비하고 AI가 헤더를 보내도록 준비한다. AI 컨테이너는 AI 팀의 별도 배포 경로를 따른다.
3. 격리 환경에서 무토큰·잘못된 토큰 거절과 정상 AI·관리자 업무를 확인한 뒤 배포 시점을 맞춘다. BE만 먼저 적용하면 기존 무토큰 AI 고객 호출이 실패한다.
4. 배포 도구로 새 환경을 가진 BE 컨테이너를 생성한다. 파일 저장이나 기존 컨테이너 restart만으로 환경 갱신을 완료했다고 판단하지 않는다. 토큰은 값 노출 없이 실행 환경의 존재 여부를 확인한다.

2026-11-09 후속 전환에서는 주문·PIN·과거 주문 주소·AI FAQ 12개에도 업무 토큰 또는 관리자 세션을 요구한다. 기존 통화별 고객 범위 검사는 유지한다. [전환 대상과 AI/프론트 반영 위치](shared-api-auth-handoff.md)를 따른다. 분석·페르소나 전용 가드, PBX와 관리자 전용 인증은 유지한다.

## 검증

`npm run check:docker`는 임시 토큰·임시 PostgreSQL을 사용해 고객 HTTP/DB, 기존 업무, 운영 이미지와 Nginx/HTTPS를 검사한다. 운영 DB·실제 AI·PBX·결제사에 접속하지 않는다.

추가 회귀 기준은 무토큰·오류/중복 토큰 차단, 설정 미비 시 차단, 거절 전후 고객·통화 보존, 실패의 AI 행위 오기록 방지, 기존 관리자 세션·역할·Origin, AI 주소 소유권, Swagger의 관리자 또는 Bearer 계약이다. 이 기준은 실제 AI 클라이언트 및 운영 배포 확인을 대신하지 않는다.
