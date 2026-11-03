# 045 적용과 인프라 후속 항목

## DB 검증문 반영

`infra/database/verify.sql`의 memberships `(organization_seq,employee_no)` 검사는 045의 **활성 행 UNIQUE index**를 검증하도록 반영했다. 기존 제약 검사를 제거해 우회하지 않고 아래 조건으로 교체했다.

```sql
IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.memberships_organization_seq_employee_no_key')
 AND i.indisunique AND i.indisvalid
 AND pg_get_indexdef(i.indexrelid) LIKE '%(organization_seq, employee_no) WHERE (deleted_at IS NULL)') THEN
 RAISE EXCEPTION 'Active organization/employee uniqueness missing';
END IF;
```

이와 함께 045 적용 기록, deleted_at 컬럼, 주문 생성자/완료 시각·페르소나 작성자 스냅샷, 통화 정리 lease, 보관 기간 인덱스를 검사한다. 기존 테이블 29개·FK 25개·업무 트리거 10개 검사는 그대로 유지한다. 사용자가 이 파일 하나의 수정 범위를 별도로 승인했다.

후속 046의 최초/마지막 전송 시각, SUBMITTING_FAILED 상태 제약, 재시도 인덱스와 적용 기록도 같은 검증문에서 확인한다. 045·046을 적용한 뒤 새 앱을 실행하며 구버전 앱과 혼용하지 않는다.

## 운영 설정

- S3 backend 역할에는 기존 업로드·재생 권한 외에 대상 버킷의 `s3:ListBucketVersions`와 `recordings/` 객체의 `s3:DeleteObject`, `s3:DeleteObjectVersion`이 필요하다. 삭제 버전/marker를 나열하고 실제 제거한다. Object Lock·MFA Delete·복제 대상이 있으면 운영 담당자가 함께 확인한다. [AWS 버전 삭제 설명](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html).
- 저장소의 Loki는 이미 retention_period=168h이며 Compactor 삭제 지연은 2시간이다. 실제 배포 설정은 별도 확인한다. stdout/요청·응답·nginx·Docker 로그의 원본 파일 보관은 수집/호스트 설정에서 확인한다. 크기 기반 회전만으로는 7일 TTL이 되지 않으며 backend의 DB 정리가 외부 로그 파일을 삭제하지 않는다.
- 백업·복제본·S3 복제 대상 및 AI/PBX가 보유한 녹취·STT·이벤트 원본도 원 통화 수신 시각부터 최대 5년 정책을 적용한다. 복원 시에는 만료 정리를 먼저 실행하고 외부 서비스에 공개한다.
- 배포 전 원본 수신 시각을 확인하지 못하는 과거 통화와 미확정 결제를 점검한다. 날짜를 임의로 현재 시각으로 바꾸지 않는다.
- 현재 재생·업로드·폐기는 S3_RECORDINGS_BUCKET 한 버킷을 사용한다. 버킷을 변경/분리할 때는 기존 객체 이관과 키 추적을 먼저 준비한다. S3 접근 장애가 나면 DB 키를 남기고 재시도하므로 에러 알림을 운영에서 확인해야 한다.

```sql
SELECT call_session_seq FROM call_sessions WHERE incoming_at IS NULL ORDER BY call_session_seq;
SELECT order_seq,status FROM orders WHERE COALESCE(closed_at,created_at)<=clock_timestamp()-interval '5 years'
 AND status IN ('PAID','SUBMITTING','SUBMISSION_FAILED');
```
