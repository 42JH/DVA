# PBX 통화 종료 웹훅

## 디버 측에 전달할 규격

```text
POST https://13.209.59.180/api/webhooks/pbx/call-ended
Content-Type: application/json
Authorization: Bearer <별도 전달하는 공유 토큰>
```

이 주소는 IP용 공인 인증서를 사용한다. TLS 인증서 검증을 끄지 않는다.
브라우저 주소창에서 열면 GET 요청이므로 405가 정상이다.
접속 확인용 주소는 `https://13.209.59.180/https-health`이며 `ok`를 반환한다.

공유 토큰 인증은 우리 측 제안이며 디버 PBX의 헤더 지원 여부를 확인해야 한다.
지원하지 않는다면 서명 등 합의한 인증 방식을 구현한 뒤 실제 통화를 연결한다.
쿼리 문자열이나 JSON 본문으로 토큰을 보내지 않는다.

```json
{
  "recordingId": "call-12345",
  "callFrom": "01012345678",
  "callTo": "07012345678",
  "startedAt": "2026-10-23T00:00:00Z",
  "endedAt": "2026-10-23T00:03:00Z",
  "durationSeconds": 180,
  "recordingUrl": "https://provider.example/recordings/call-12345.mp3"
}
```

| 필드 | 현재 검증 |
|---|---|
| recordingId | 전체 통화에서 유일한 문자열, 1~200자, 재전송 시 같은 값 |
| callFrom, callTo | 숫자 3~20자리, 앞의 `+` 선택 가능. 문자열이므로 앞자리 0 유지 |
| startedAt, endedAt | 시간대 필수인 ISO 8601. `Z` 또는 `+09:00` 등, 소수초 최대 3자리. 종료 시각 >= 시작 시각 |
| durationSeconds | 0 이상의 정수, 최대 2,147,483,647. 실제 과금/대화 시간과 벽시계 차이는 강제 비교하지 않음 |
| recordingUrl | HTTPS URL, 최대 8,192자. URL 내 사용자명·비밀번호·fragment는 불가 |

일곱 필드는 필수이며 추가 필드는 현재 무시한다. JSON 본문 한도는 16 KiB다.
날짜는 UTC로 정규화하며 나머지 필드 값은 그대로 보관한다.
숨김 발신번호, 필드 변경, 녹취 URL 갱신 정책이 필요하면 사전 협의한다.

## 응답과 재전송

최초 저장이 DB에 커밋된 후 HTTP 200을 반환한다.

```json
{"status":"received","recordingId":"call-12345","duplicate":false}
```

같은 `recordingId`와 같은 내용이 다시 오면 HTTP 200, `duplicate: true`다.
동시 요청도 DB 기본키로 한 건만 저장한다. 같은 시각을 다른 시간대로 표현하거나
추가 필드만 붙이는 것은 같은 내용으로 취급한다.

| HTTP | 의미 / 송신 측 처리 |
|---|---|
| 200 | 저장 완료 또는 동일 내용 재수신. 추가 재전송 불필요 |
| 400 | 잘못된 JSON/필드. 데이터 수정 필요 |
| 401 | 인증 누락/불일치. 인증 설정 확인 |
| 405 | POST 외 메서드 |
| 409 | 같은 recordingId에 다른 내용. 원본 유지, 운영 확인 필요 |
| 413 | 본문 16 KiB 초과 |
| 503 | 인증 설정 미완료 또는 DB 저장 실패. 원인 해결 후 동일 내용 재전송 |
| 타임아웃·502·504 | 수신 결과 불명 또는 프록시 오류. 동일 내용 재전송 |

네트워크 오류나 재시도 가능한 오류에는 동일 ID·동일 본문으로 지수 백오프 재시도를 제안한다.
재시도 횟수·간격·PBX 응답 제한 시간은 디버 측과 확정해야 한다.
서명/만료 파라미터가 바뀐 `recordingUrl`도 다른 내용이다. 기존 ID를 재사용해 덮어쓰지 않는다.

## 저장 및 후속 처리 범위

현재는 모놀리식 DB의 `pbx_webhooks.call_ended_events`에 일곱 필드와 수신 시각,
`processing_status=RECEIVED`를 영구 저장한다. 원본 녹취 URL은 서명 파라미터까지 보관하므로
DB 접근 권한과 백업에 동일한 개인정보 보호 기준을 적용한다. 요청 본문/인증 헤더를 로그에 남기지 않는다.

테이블은 백엔드 시작 시 트랜잭션과 advisory lock으로 생성한다. 생성 권한이 없거나 DB가
연결되지 않으면 시작에 실패하며, 기존 릴리스로 복구할 수 있다. 이후 변경은 새 migration으로 추가한다.
이번 migration은 별도 schema/table을 추가하며 기존 업무 테이블과 `msa/liquibase`를 변경하지 않는다.

`recordings.object_key`는 저장 완료된 음성 파일용이므로 외부 URL을 넣지 않는다.
`call_sessions` 연결, S3 복사, URL 만료/다운로드 인증 처리, AI 종료 트리거/분석 워커는 아직 연결하지 않았다.
200 응답은 웹훅 저장 완료를 뜻하며 AI 처리 완료를 뜻하지 않는다.

## 공유 토큰 관리

서버 `/home/ubuntu/dva-deploy/shared/.env`의 `PBX_WEBHOOK_TOKEN`을 사용한다. 현재 서버에서
무작위 32바이트를 생성했고 파일 권한은 600이다. Git·Jenkins 산출물에는 포함하지 않는다.

원본 PEM으로 접속 가능한 Windows PowerShell에서 다음 명령을 실행하면 화면에 토큰을
출력하지 않고 클립보드로 복사할 수 있다. 디버 담당자에게 합의한 비공개 경로로 전달하고 클립보드를 비운다.

```powershell
ssh -i 'C:\Users\SSAFY\Desktop\기업연계\dva-monolith.pem' `
  -o StrictHostKeyChecking=yes `
  -o 'UserKnownHostsFile=C:/Users/SSAFY/dva/infra/deploy/known_hosts' `
  ubuntu@13.209.59.180 'sed -n "s/^PBX_WEBHOOK_TOKEN=//p" ~/dva-deploy/shared/.env' | Set-Clipboard
```

토큰 교체 시 서버 환경 파일 변경 후 현재 릴리스의 `deploy.sh`를 재실행하여 컨테이너에 반영하고
디버 측 설정을 함께 변경한다. 현재는 단일 토큰 방식이다.

## 검증

```powershell
# Docker Desktop 실행 상태에서 임시 PostgreSQL 사용. 실제 운영 DB에 연결하지 않음.
& ./infra/deploy/test-webhook.ps1
```

2026-10-23 검증:

- 실 PostgreSQL 기반 7개 통합 테스트 통과: 인증 실패, 설정 누락, 입력 오류, 저장·중복·충돌,
  12개 동시 요청, DB 저장 장애, 백엔드 재시작 후 데이터 유지
- 운영 이미지 네 개로 임시 Compose 기동, Nginx 경유 저장/재전송, DB·AI readiness 통과
- Lightsail 릴리스 `pbx-ip-20261023-01` 배포 및 네 서비스 healthy 확인
- 외부 Windows PC에서 공인 인증서 검증을 유지한 HTTPS 요청 성공
- 실제 주소의 200·400·401·405·409 및 비공개 API 404, 평문 HTTP 웹훅 404 확인
- 테스트 통화 한 건의 DB 영구 저장을 확인하고 해당 테스트 행만 제거
- 디버 PBX에서 보내는 실제 통화 수신과 Bearer 지원 여부는 협의·검증 대기
