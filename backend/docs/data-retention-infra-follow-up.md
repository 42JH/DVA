# 045 적용과 인프라 후속 항목

## DB 검증문 수정 제안

현재 `infra/database/verify.sql`은 memberships의 `(organization_seq,employee_no)`가 UNIQUE **constraint**인지 확인한다. 045는 같은 열의 **활성 행 UNIQUE index**로 바꾸므로 기존 검증문은 정상 스키마를 거절한다. 검사를 제거하지 않고 아래 검사로 교체해야 한다.

```sql
IF NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.memberships_organization_seq_employee_no_key')
 AND i.indisunique AND i.indisvalid
 AND pg_get_indexdef(i.indexrelid) LIKE '%(organization_seq, employee_no) WHERE (deleted_at IS NULL)') THEN
 RAISE EXCEPTION 'Active organization/employee uniqueness missing';
END IF;
```

이와 함께 045 적용 기록, deleted_at 컬럼, 주문 생성자/완료 시각·페르소나 작성자 스냅샷, 통화 정리 lease, 보관 기간 인덱스를 검사한다. 기존 테이블 29개·FK 25개·업무 트리거 10개 검사는 그대로 유지한다. 사용자가 이 파일 하나의 수정 범위를 별도로 승인했다.

## 운영 설정

- S3 backend 역할에는 기존 업로드·재생 권한 외에 대상 버킷의 `s3:ListBucketVersions`와 `recordings/` 객체의 `s3:DeleteObject`, `s3:DeleteObjectVersion`이 필요하다. 삭제 버전/marker를 나열하고 실제 제거한다. Object Lock·MFA Delete·복제 대상이 있으면 운영 담당자가 함께 확인한다. [AWS 버전 삭제 설명](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DeletingObjectVersions.html).
- stdout/요청·응답·nginx·Docker 로그의 파일 보관은 수집/호스트 설정에서 7일로 적용한다. backend의 DB 정리만으로 외부 로그 파일은 삭제되지 않는다.
- 백업·복제본·S3 복제 대상 및 AI/PBX가 보유한 녹취·STT·이벤트 원본도 원 통화 수신 시각부터 최대 5년 정책을 적용한다. 복원 시에는 만료 정리를 먼저 실행하고 외부 서비스에 공개한다.
- 배포 전 원본 수신 시각을 확인하지 못하는 과거 통화와 미확정 결제를 점검한다. 날짜를 임의로 현재 시각으로 바꾸지 않는다.

```sql
SELECT call_session_seq FROM call_sessions WHERE incoming_at IS NULL ORDER BY call_session_seq;
SELECT order_seq,status FROM orders WHERE COALESCE(closed_at,created_at)<=clock_timestamp()-interval '5 years'
 AND status IN ('PAID','SUBMITTING','SUBMISSION_FAILED');
```
