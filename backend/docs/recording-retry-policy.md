# S09 녹취 재시도 제한과 운영 확인

녹취 수신 후 복구할 수 없는 실패를 계속 선정하던 경로를 제한한다. 기존 PBX 인증·수신 JSON·200/409 응답, AI 업무 API, 관리자 통화·녹취 조회와 재생 URL은 유지한다. AI·프론트 필수 수정이나 새 환경변수는 없다.

## 처리 정책

| 상황 | 처리 |
| --- | --- |
| 최초 수신 | 기존처럼 최소 1분 후 매칭·처리. 워커는 10초마다 최대 5건 확인 |
| 정상적인 통화 매칭 대기·S3 미설정 | 시도 횟수를 소진하지 않음 |
| 다운로드·저장 처리 | 최초 포함 최대 5회. 실패 후 1분 → 5분 → 15분 → 30분 |
| 허용되지 않은 URL·비공개 DNS 주소·파일 크기·형식 위반·기존 객체 충돌 | 즉시 확인 대기 |
| 원본 401/403·404/410·429·5xx, 네트워크·S3·DB 일시 오류 | 제한된 재시도. 403/404만으로 만료·삭제를 단정하지 않음 |
| 5회 실패 또는 마지막 시도 중 워커 종료 | 확인 대기. 여섯 번째 저장 요청은 실행하지 않음 |
| 성공 | 기존 PROCESSED. 재시도 시각·실패 코드·확인 플래그 해제, 시도 수는 보존 |

시도 횟수는 외부 저장소 호출 전에 DB에 저장한다. 프로세스 종료·재시작·동일 웹훅 재전송으로 초기화되지 않는다. 외부 SDK 내부 재시도는 한 번의 워커 시도에 포함되며 기존 S3 SDK·다운로드·업로드 시간 제한과 5분 lease를 유지한다. 매칭·검증 자체가 예외로 실패한 경우도 처리 실패로 집계한다.

`processing_status`의 RECEIVED·FAILED·PROCESSED는 유지한다. 내부 컬럼 `attempt_count`, `next_attempt_at`, `last_error_code`, `requires_review`로 재시도를 제어한다. 오류 코드는 고정된 값만 저장하며 원본 URL·서명·전화번호·외부 오류 메시지는 기록하지 않는다.

이미 업로드된 S3 객체는 기존 메타데이터·크기 검증 후 재사용한다. S3 HEAD 404는 기존처럼 미저장으로 처리하며 원본 다운로드 404와 구분한다. 객체·DB 참조 충돌은 파일을 덮어쓰거나 삭제해 해결하지 않는다.

## 기존 데이터와 배포

새 migration은 `054-recording-retry-policy.sql` 한 개다. 기존 migration 파일은 수정하지 않는다.

- 기존 FAILED는 원인 기록이 없어 `requires_review=true`, `last_error_code=LEGACY_FAILURE`로 이행한다. 과거 시도 수는 복원할 수 없어 0으로 시작한다. **기존 실패 건의 자동 복구도 중지되므로 배포 전에 건수와 후속 담당을 확인한다.**
- RECEIVED·PROCESSED, 원본 payload·ID·수신 시각·통화 연결·lease·기존 녹취와 S3 객체는 보존한다.
- 확인 대기도 기존 보관 정책을 따른다. 미연결 수신은 30분 후 정리하고, 연결된 통화는 기존 soft delete·최초 수신부터 5년 폐기를 따른다. 보류 때문에 보관 기간을 연장하지 않는다.
- 기존 워커 중지 → 백업 → 054·verify.sql → 새 앱 순서로 전환한다. SQL 실패 시 신규 DDL·이행을 롤백한다.
- 새 deploy.sh는 054 최초 적용 전에 백엔드를 중지·백업하고, 054 적용 후 재시도 제한을 모르는 구버전의 배포·명시적 롤백·자동 복귀를 차단한다. 호환 앱으로 복구하고 보호 로직이 없는 과거 deploy.sh를 직접 실행하지 않는다.

운영 현황은 권한 있는 DB 운영자가 원문 없이 확인한다.

```sql
SELECT processing_status, requires_review, last_error_code, count(*) AS receipt_count
FROM pbx_webhooks.call_ended_events
GROUP BY processing_status, requires_review, last_error_code
ORDER BY processing_status, requires_review, last_error_code;
```

054 적용 전에는 새 컬럼이 없으므로 `processing_status`별 건수만 조회한다. migration과 이 문서는 운영 DB에 자동 실행하지 않는다.

## 운영 확인 후 재개

원본과 통화 연결을 확인하고 네트워크·권한·설정·파일 원인을 해결한 뒤 권한 있는 DB 운영자가 한 건씩 재개한다. 진행 중 lease·삭제/보관 만료 통화·미연결 30분 초과 건은 재개하지 않는다. 다음 SQL은 psql에서 검토한 ID 한 개에만 사용하며 RETURNING이 1건인지 확인한다.

```sql
\set recording_id '검토한 recordingId'
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='10s';
UPDATE pbx_webhooks.call_ended_events e
SET attempt_count=0, next_attempt_at=NULL, last_error_code=NULL,
    requires_review=false, last_attempt_at=NULL, claim_id=NULL, claimed_until=NULL
WHERE e.recording_id=:'recording_id'
  AND e.processing_status='FAILED' AND e.requires_review
  AND (e.claimed_until IS NULL OR e.claimed_until<=clock_timestamp())
  AND ((e.call_session_seq IS NULL AND e.received_at>clock_timestamp()-interval '30 minutes')
    OR EXISTS(SELECT 1 FROM call_sessions c WHERE c.call_session_seq=e.call_session_seq
      AND c.deleted_at IS NULL
      AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')))
RETURNING recording_id, processing_status, attempt_count, requires_review;
COMMIT;
```

0건이면 원인을 확인하고 진행 중 작업을 강제로 해제하지 않는다. 재개는 원본 payload·recordingId·통화 연결·S3 객체를 바꾸지 않으며 다음 워커 실행에서 새 5회 예산을 사용한다. 일반 PBX 재전송은 이 예산을 초기화하지 않는다.

만료된 URL의 재발급은 제공자와 별도 계약이 필요하다. 같은 ID에 다른 URL을 보내는 기존 409 검증은 유지하며, 이 재개 SQL만으로 만료 URL을 복구할 수는 없다. 새 관리자 재처리 API·화면은 추가하지 않는다.

## 검증 범위

고정 오류 코드·정책 위반·원본 HTTP 오류 분류, 5회/간격 경계, 재시작·만료 lease·오래된 작업자의 쓰기 차단, 정상 업로드·S3 객체 재사용·DB 실패 복구, 보류 후 다른 녹취 진행, 동일 웹훅 중복/충돌, 미연결 30분 정리, 수동 재개와 기존 조회·재생을 검증한다.

임시 DB에서 기존 053 데이터의 054 이행·실패 롤백·원본/lease 보존·백업 복원을 검증한다. 배포 시뮬레이션은 중지·백업 순서, SQL/검증/앱 실패, 호환 복구와 비호환 복귀 차단을 확인한다. 실제 PBX·S3·운영 DB·운영 배포는 별도다.
