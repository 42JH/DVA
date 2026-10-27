# 녹취 S3 설정과 운영 확인

코드는 PBX 수신 → 통화 매칭 → 원본 다운로드 → 비공개 S3 저장 → DB 연결까지 처리한다. 사용자는 **버킷과 AWS 권한·환경변수**를 준비한다. AI 호출부 변경은 [연동 명세](ai-pbx-recordings.md)에 따라 AI 팀에서 반영한다.

## AWS에서 할 설정

1. 사용할 리전에 일반 S3 버킷을 만든다. 예: `dva-private-recordings-팀고유값`. 공개 액세스 차단을 모두 켜고 Object Ownership은 Bucket owner enforced를 사용한다. 브라우저 공개 읽기나 ACL 설정은 필요 없다.
2. 기본 서버 측 암호화를 유지한다. 아래 권한 예시는 SSE-S3 기준이며, 별도 KMS 키를 선택하면 그 키에 대한 권한도 필요하다.
3. 백엔드 실행 주체에 아래 정책을 연결한다. `YOUR_BUCKET`을 실제 버킷명으로 바꾼다. HEAD로 업로드 완료 객체를 재사용하므로 읽기 권한이 필요하고, 없는 객체를 404로 구분하기 위해 ListBucket도 부여한다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::YOUR_BUCKET/recordings/*"
    }
  ]
}
```

삭제·공개 ACL·버킷 생성 권한은 앱에 주지 않는다. 이 버킷은 녹취 전용으로 사용한다. 버킷 소유권을 확인하고, 같은 키 공간에 다른 업로더를 두지 않는다.

EC2 역할 등 실행 환경의 임시 자격 증명을 우선 사용한다. 현재 호스트에서 역할을 연결할 수 없다면 배포 비밀 설정으로 접근 키를 주입한다. SDK는 [기본 자격 증명 체인](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-credentials-node.html)을 사용하며 코드에 키를 넣지 않는다.

## 서버에 넣을 값

```dotenv
AWS_REGION=ap-northeast-2
S3_RECORDINGS_BUCKET=YOUR_BUCKET
```

역할을 사용할 수 없는 경우에만 `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`를 배포 비밀에 등록한다. 임시 자격 증명이면 `AWS_SESSION_TOKEN`도 필요하다. 값은 채팅·Git·MR에 붙이지 않는다.

추가 기본값은 Compose에서 이미 전달한다.

| 설정 | 기본값·의미 |
| --- | --- |
| `RECORDING_ALLOWED_HOSTS` | `dvercorp-aicc-connect-dev-recordings.s3.ap-northeast-2.amazonaws.com`. 실제 PBX 수신 URL에서 확인한 다운로드 호스트. 변경 시 정확한 호스트를 쉼표로 지정 |
| `RECORDING_MATCH_WINDOW_SECONDS` | 30. 발신번호가 같은 OpenAI/PBX 시작 시각의 허용 차이(±초). 1~300 허용 |
| `PBX_WEBHOOK_TOKEN` | 기존 서버 전용 Bearer 토큰 유지 |
| `DVER_API_KEY` | 완성 주문 접수에 필요한 기존 디버 키 |

버킷이 비어 있으면 웹훅 수신은 가능하고 S3 워커는 비활성 상태다. 설정을 넣은 새 컨테이너가 실행되면 보관된 수신부터 처리한다. 프로세스 환경변수 변경은 실행 중 컨테이너에 자동 반영되지 않으므로 팀 배포 절차로 새 앱을 실행한다.

이 변경의 `011-call-recording-correlation.sql`도 앱 교체 전에 적용해야 한다. 기존 Jenkins 배포의 migration 단계가 처리하며 운영 DB에 테스트 스크립트를 실행하지 않는다.

## 다운로드·업로드 동작

- 원본은 별도 인증 헤더 없이 GET 가능한 HTTPS URL 또는 서명 URL이어야 한다. URL의 서명이 만료되기 전에 최초 다운로드가 완료되어야 한다.
- 정확한 호스트 허용 목록·443 포트·공개 DNS 주소를 검사한다. 리다이렉트, 내부/루프백/메타데이터 주소, URL 사용자 비밀번호는 허용하지 않는다.
- `audio/*` 또는 `application/octet-stream`만 저장한다. 파일당 최대 32 MiB, 다운로드·업로드 각 최대 60초다. 크기 초과나 실패 시 수신은 FAILED로 남는다.
- `recordings/<recordingId SHA-256>` 키로 조건부 PutObject를 사용한다. 같은 키가 이미 있으면 덮어쓰지 않고 저장된 통화 번호와 크기를 확인한다. [S3 PutObject 계약](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)을 따른다.
- SDK 요청에는 공개 ACL을 지정하지 않는다. DB에는 공개 URL 대신 객체 키만 저장한다. 원본 서명 URL은 기존 PBX 수신함에 있으므로 이 테이블의 읽기 권한도 제한한다.
- 재생 URL 발급·음성 전사·자동 보관 기간 삭제는 이번 수신/저장 변경의 범위가 아니다. 보관 기간이 정해지기 전 임의 Lifecycle 삭제를 설정하지 않는다.

## 배포 후 확인

AI 팀 규격 반영 후 시험 통화 한 건으로 확인한다. 개발 검증에서는 실제 디버 주문이나 AWS 리소스를 생성하지 않았다.

```sql
-- URL·전화번호 없이 적체와 실패를 확인한다.
SELECT processing_status, count(*)
FROM pbx_webhooks.call_ended_events
GROUP BY processing_status;

SELECT recording_id, processing_status, call_session_seq, received_at, last_attempt_at
FROM pbx_webhooks.call_ended_events
WHERE processing_status <> 'PROCESSED'
ORDER BY received_at;

SELECT c.call_session_seq, c.order_seq, c.incoming_at, c.started_at, c.ended_at,
       r.recording_seq, r.object_key
FROM call_sessions c
LEFT JOIN recordings r USING (call_session_seq)
ORDER BY c.call_session_seq DESC LIMIT 20;
```

- `RECEIVED`, 연결 없음: AI 결과 미도착, 번호/시각 불일치 또는 복수 후보. AI 이벤트와 PBX 시작 시각을 먼저 확인한다. 가까운 후보를 임의로 선택하지 않는다.
- `FAILED`, 연결 있음: S3 권한·리전·버킷, URL 유효기간, 다운로드 크기·형식, DB 상태를 확인한다. 원인을 고치면 워커가 최소 1분 간격으로 재시도한다.
- 기존 S3 객체가 있는데 계속 FAILED면 객체의 통화 메타데이터와 DB 참조 충돌을 확인한다. 같은 키의 파일을 삭제하거나 덮어써서 우회하지 않는다.
- PBX 재시도는 같은 recordingId·같은 본문을 사용한다. 만료 URL의 재발급/보류 후보 수동 연결은 자동 추정하지 않으며, 제공자 원본과 통화 이벤트를 확인한 운영 처리가 필요하다.

최종 확인 기준은 수신함 `PROCESSED`, 해당 통화의 `recordings` 행, 비공개 S3 객체가 모두 존재하는 것이다. 웹훅 200이나 Swagger 호출 성공만으로 업로드 완료를 판단하지 않는다.
