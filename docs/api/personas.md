# 페르소나 설정·버전·적용 API

분류 단건·다건 삭제는 [배열 삭제 API와 ACTIVE 보호 명세](../../backend/docs/persona-bulk-deletion.md)를 따른다. `DELETE /api/personas` 하나로 분류·전체 버전·초안을 soft delete하며, 실제 ACTIVE 버전이 있는 분류는 삭제할 수 없다.

최신 입력·조회와 060 기존 데이터 이관은 [항목별 저장 명세](../../backend/docs/persona-prompt-fields.md)를 따른다. 기존 URL과 초안·HEAD·publish 흐름을 재사용한다.

최신 명세는 [유형별 HEAD와 publish 관리 계약](../../backend/docs/persona-head-management.md)으로 통합했다. 생성·수정·목록·이력·publish 입력과 응답 필드, migration 036 적용·복구 순서는 해당 문서를 따른다.

AI 인증·지원 옵션·알림·적용 회신은 [다음 통화 적용 명세](../../backend/docs/ai-persona-next-call.md)를 따른다.
