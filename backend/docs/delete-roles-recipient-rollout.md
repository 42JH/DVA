# 백엔드 배포 안내 — DELETE·관리자 권한·수령인 전화번호

대상은 모놀리식 MR !560, develop-backend입니다. MSA와 프론트/AI 소스는 수정하지 않습니다.

## 배포 순서

1. [프론트 통합 명세](frontend-delete-admin-roles.md)의 DELETE 경로/배열 body와 두 역할 UI 조건, [AI 명세](recipient-phone-ai.md)의 전화번호 검증을 준비합니다.
2. 기존 운영 정책대로 DB 백업을 확보하고 구버전 앱의 관리자 권한 쓰기를 중지합니다. 기존 migration 001~065는 수정하지 않습니다.
3. 기존 배포 파이프라인의 migration 단계에서 **`066-admin-role-consolidation.sql`**을 트랜잭션과 checksum ledger를 사용하는 기존 방식으로 적용합니다. 새 앱은 066 적용 후 기동합니다. 이 문서는 운영 DB에 수동 SQL 적용을 요청하지 않습니다.
4. 새 백엔드와 프론트를 함께 배포하고 AI 전화번호 검증을 맞춥니다. 추가 환경변수·Nginx 변경은 없습니다.
5. 기존 세션으로 `/api/auth/me`를 재조회합니다. 운영자는 계정 관리 4개를 제외한 91개 관리자 업무 API, 최상위 관리자는 95개를 사용할 수 있습니다. 실시간 통화 수 SSE도 포함한 수치입니다.

## 066의 실제 변경

- 모든 SUPERVISOR 계정을 OPERATOR로 전환합니다. ACTIVE/PENDING/INACTIVE와 soft-deleted 계정도 처리하며 이름·비밀번호·삭제 상태·세션·과거 업무 참조는 보존합니다.
- 전환한 계정마다 `SYSTEM / ADMIN_ACCESS_CHANGED / ADMIN_USER / SUCCESS` 감사 기록을 같은 트랜잭션에서 남깁니다. 같은 실행 requestId를 사용하며 metadata는 빈 객체입니다. 이름·전화·주소·인증 값은 감사 내용에 넣지 않습니다.
- DB `admin_users_role_check`를 OPERATOR/SYSTEM_ADMIN 두 값으로 제한합니다. 감사 저장 또는 제약 갱신 실패 시 계정 변경도 전체 롤백합니다.
- 기존 세션은 요청마다 현재 DB 역할을 조회하므로 별도 세션 삭제 없이 OPERATOR로 반영됩니다. 프론트의 캐시된 역할은 내 정보 재조회로 갱신합니다.

## 유지·복구 범위

계정 관리 4개와 SYSTEM_ADMIN 삭제/권한/상태 보호, ACTIVE 페르소나 보호, AI 전용 토큰, soft delete·감사·보관 정책을 유지합니다. 전화번호는 기존 text/JSON에 저장하므로 전화번호용 DB 변경은 없습니다. 새 입력과 접수 검증에 적용하고 기존 저장 번호는 일괄 변경하지 않습니다.

구형 단건 DELETE URL은 새 앱에서 404입니다. 프론트와 백엔드 배포를 같이 맞춰야 합니다. 066 적용 후 앱 이미지만 구버전으로 되돌려도 OPERATOR로 이관한 계정이 SUPERVISOR로 복원되지는 않습니다. 복구가 필요하면 배포 전 백업 및 실제 계정·감사 상태를 확인하고 별도 승인된 복구 작업으로 처리합니다.

최종 검증 결과는 MR 본문에 기록합니다. 이 작업에서 운영 배포·운영 계정 이관·실제 PG/디버 접수는 수행하지 않습니다.
