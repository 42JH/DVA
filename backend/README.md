# 모놀리식 백엔드 공통 기반

최종 홈 화면의 오늘 주문·통화 건수와 최대 11개 미리보기는 [프론트 QA 연동 명세](docs/frontend-qa-api.md)를 따른다. 주문 전체는 실제 주문, 미완료는 배송 단건 초안으로 유지하고 미답변 질문의 정확한 발화 연결은 현행 보장 범위에 포함하지 않는다. [후속 작업·검증 기록](docs/final-wireframe-follow-up.md)을 함께 확인한다.

API 성능 개선은 [계획·동일 결과 검증·측정 기록](docs/api-performance-optimization.md)을 따른다. 응답·기능·오류·권한·보관 기준을 유지하며, 관리자 주문 목록의 배송상세 JSON과 통화 목록의 recordedAt은 페이지 선택 후 해당 행만 계산한다. 홈의 AI 통계 4개는 대상 통화 조회를 공유하며 개별 통계 API와 같은 값을 반환한다. 페르소나 목록·상세는 기존 버전·초안·프롬프트를 유지하면서 현재 페이지의 상세만 구성한다. 추가 migration·환경변수는 없다.

프론트 QA 반영 작업은 [API 계약·검증 기록](docs/frontend-qa-api.md)을 따른다. 관리자 주문 목록은 기존 목록 필드에 같은 검색·기간·기업 조건의 statusCounts를 추가하며 미완료는 INCOMPLETE 배송 초안 목록으로 연결한다. GET /api/dashboard/home은 처리할 일·최대 5개 미리보기·기존 AI 통계 4개를 하나의 조회 스냅샷으로 제공한다. DELETE /api/companies는 organizationSeqs 배열 1~100개를 전체 성공·실패 단위로 처리하고 기존 단건 URL도 유지한다. 추가 migration은 없다.

관리자 목록 GET /api/admins는 선택 q로 이름·로그인 아이디를 대소문자 구분 없이 부분 검색한다. 앞뒤 공백 제거 후 최대 100자이며 빈 검색어는 기존 목록, %, _는 일반 문자다. 기존 권한·상태 필터와 함께 페이지 적용 전 전체 계정에 검색하고 SYSTEM_ADMIN 전용 세션·삭제 계정 제외·공개 응답 정제를 유지한다. 실제 로그인 규칙과 DB는 변경하지 않으며 [작업·검증 기록](docs/admin-list-search-plan.md)을 따른다. 전달 명세는 후속 작업과 누적한다.

기업별 사원 목록 GET /api/companies/{id}/members는 선택 q로 해당 기업의 이름·사번·전화번호를 부분 검색한다. 이름·사번은 대소문자를 구분하지 않고 전화번호는 하이픈·뒷자리 검색을 허용한다. 최대 100자이며 빈 검색어는 기존 목록, %, _는 일반 문자다. status와 함께 적용하며 응답·정렬·페이지/전체 건수·관리자 권한·삭제 기준과 전체 사원 검색 API는 유지한다. DB 변경은 없고 [작업·검증 기록](docs/company-member-list-search-plan.md)을 따른다. 전달 명세는 후속 작업과 누적한다.

고객 목록 GET /api/customers의 availablePaymentMethods는 고객 확인 API와 같은 기준으로 현재 가능한 billing(개인 카드)·credit(월결제)·groupBilling(부서 그룹결제)을 순서대로 반환한다. 탈퇴 고객은 빈 배열이며 삭제 고객은 제외한다. 목록 SQL에서 함께 계산하므로 고객별 context 호출이 필요 없다. 고객 상세·공통 고객 DTO와 실제 주문·결제 자격 재검증은 유지하며 DB 변경은 없다. [작업·검증 기록](docs/customer-list-payment-methods-plan.md)을 따른다. 전달 명세는 후속 작업과 누적한다.

통화 목록·상세와 관리자 주문 목록은 현재 소속 기업명 organizationName을 반환하며 organizationSeq 필터를 받는다. 관리자 주문 목록에는 customerSeq도 제공한다. 기업명 있음은 기업 고객, 기업명 없음+customerSeq 있음은 현재 무소속, customerSeq=null은 미확인으로 표시할 수 있으며 별도 고객 유형 필드는 추가하지 않는다. 비활성 소속·기업도 표시하고 삭제된 연결은 숨긴다. 현재 소속 기준이므로 과거 목록 표시도 바뀌며 결제 당시 기업 스냅샷과 다르다. DB 변경과 AI 일반 주문 조회 변경은 없고 전달 명세는 후속 작업과 누적한다. [작업·검증 기록](docs/list-customer-organization-plan.md)을 따른다.

통화 분석 상태는 [AI 실패 통보](docs/call-analysis-status-ai-integration.md), [프론트 조회](docs/call-analysis-status-frontend-integration.md), [056 적용 순서](docs/call-analysis-status-rollout.md)를 따른다. 목록·상세에 analysisStatus와 최초 녹취 DB 저장 시각 recordedAt을 제공한다. 정상 분석이면 COMPLETED 우선, 없고 AI 최종 실패 통보가 있으면 FAILED, 둘 다 없으면 PENDING이다. 실패 API는 기존 AI_INSIGHTS_TOKEN을 사용하며 AI_BUSINESS_TOKEN과 다르다. 시간 경과·녹취·주문 결과로 실패를 추정하지 않는다.

055 배송 단건 초안은 [AI 전송 명세](docs/parcel-draft-ai-integration.md), [프론트 연동 명세](docs/parcel-draft-frontend-integration.md), [배포·복구](docs/parcel-draft-rollout.md)를 우선한다. 통화 중에는 초안만 저장하고 PBX 종료와 AI 완료 후 READY를 실제 주문 하나로 변환한다. EDITING은 고객 등록 전에도 보존한다. 새 참조는 논리 참조이며 주소·물품·발신번호 사본은 원본 삭제와 독립적으로 최초 수집부터 5년 보관한다. 055는 한 번의 migration으로 적용하며 기존 쓰기 중지·백업 후 새 AI/프론트와 함께 전환한다. 아래 AI ORD-01 일괄 생성 설명은 055 이전 등록 통화의 호환 경로에 해당한다.

고객 단독 등록 `POST /api/customers`는 이름·11자리 전화번호·주소가 필수다. 상세주소만 생략·빈 문자열을 허용한다. [주소 필수 연동 안내](docs/customer-registration-address.md)와 [고객 API](../docs/api/customers.md)를 따른다. 주소 수정·과거 고객 조회·주문 내 고객 연결·기업 사원 등록의 별도 계약과 DB 스키마는 유지한다.

주문 상세 물품가액은 [주문 결제 계약](../docs/api/order-billing.md)에 따라 1원~1억원 정수만 받는다. AI·수기 생성과 수정의 범위 오류는 400, 저장된 범위 밖 가액의 최종 접수·최초 카드 승인·디버 전송은 422다. 승인 절차가 이미 시작된 결제의 결과 확인·복구는 유지한다. 수집 중 생략·null과 과거 값 조회는 유지하며 배송비 정책·DB 스키마는 변경하지 않는다.

S10은 [인증 보안 기록·탐지 운영](docs/security-auth-observability.md)을 따른다. production은 backend 전용 `SECURITY_LOG_HMAC_KEY`(32바이트 난수의 64자리 hex)를 먼저 주입한다. AI·프론트에는 공유하지 않는다. 인증 계약·S04 제한·DB는 유지하며, Alloy/Grafana 관측 설정은 별도로 반영한다.

S11 의존성 변경·npm 재검사와 미해결 개발 도구 항목은 [의존성 보안 정리](docs/dependency-security-review.md)를 따른다. 운영 패키지 버전은 유지하고 취약 개발 도구의 전이 의존성만 교체했다.

S09 녹취 처리는 [재시도·이행·운영 재개 절차](docs/recording-retry-policy.md)를 따른다. 새 앱 전에 054를 적용하고 기존 워커를 중지·백업한다. 최초 포함 최대 5회, 실패 후 1·5·15·30분 간격이며 정책 위반·상한 초과는 확인 대기다. 기존 FAILED는 원인 미상으로 보류하며 원본·녹취·기존 보관 정책을 유지한다. AI·프론트·PBX 계약과 환경변수는 그대로다.

S05 결제 복구는 [실패 판정·연동 영향·운영 절차](docs/payment-approval-recovery.md)를 따른다. 최초 승인에서 확인한 결제 정보 없음·세션 만료는 기존 422로 반환하고 같은 링크의 재결제를 허용한다. 미확정 건의 조회 404·인증 오류·타임아웃은 확인 대기를 유지한다. AI·관리자 프론트의 API·환경변수와 DB 스키마는 변경하지 않는다.

관리자 로그인·가입과 비밀번호 처리는 [S04 인증 요청 제한](docs/auth-request-limits.md)을 따른다. 로그인 IP 평균 30회/분·burst 5, 가입 IP 10분 5회·24시간 20회, ID별 15분 5회 실패 시 5분 제한, 비밀번호 처리 전체 동시 2개를 적용한다. 가입 이름은 50자·새 비밀번호는 256자까지이며 기존 비밀번호 검증은 유지한다. 429·Retry-After 처리와 호스트 Nginx 별도 적용 순서를 확인한다. 승인 대기 30일은 수동 검토 기준이다.

고객 확인·등록·상세·수정의 AI 호출은 `Authorization: Bearer <AI_BUSINESS_TOKEN>`을 요구한다. 미설정 시 해당 AI 호출은 503, 누락·오류 토큰은 401이다. 관리자 세션·Origin과 AI 주소 수정의 진행 중 본인 통화 검사는 유지한다. [S01 설정·전환·검증](docs/ai-business-auth.md)을 따른다. 주문·PIN 등 나머지 MVP 경로의 서비스 인증과 통화별 권한은 별도 범위다.

업무 전화번호는 [휴대전화 번호 입력 계약](docs/mobile-phone-integration.md)에 따라 정확히 11자리 숫자 문자열로 받는다. 고객·고객 확인·직원·PIN·주문 입력 및 저장 주문의 최종 접수 검증에 적용한다. 수집 중 생략·null, 기존 저장 데이터 조회, PBX 원문 국제 표기 수신은 유지한다. 프론트·AI 전달 범위도 해당 문서에 정리했다.

미확정 결제의 5년 보관 만료는 [결제 보관·입력 검증 작업 계획](docs/payment-retention-and-mobile-plan.md)과 [보관 계약](docs/data-retention.md)을 따른다. 만료 건은 승인·복구 큐에서 제외하고 실제 승인·안내·디버 요청의 기존 점유 시간만 보호한 뒤 FK 순서대로 폐기한다. 오래된 결제 상태만으로 무기한 보존하지 않으며 기한 안의 미확정 결제 보호와 기존 결제·취소 API 계약은 유지한다. 이 변경의 추가 migration은 없다.

FAQ 상세 고객 질문 사례는 [AI 전송 명세](docs/faq-question-examples-ai-integration.md)와 [프론트 조회 명세](docs/faq-question-examples-frontend-integration.md)를 따른다. 앱 교체 전에 migration 052를 적용한다. FAQ_ANSWERED의 faqEntrySeqs 배열(기존 단건 호환)과 고객 발화를 받아 독립 텍스트로 복사해 관리자 상세 recentQuestions에 최신 10개만 제공한다. 같은 문장은 별도 사례로 유지하고 동일 이벤트 재전송은 추가하지 않는다. 통화 삭제와 독립적으로 응대 발생부터 5년까지 보관하며 FAQ 수정·삭제 시 사례를 비운다. 수정 전 발생한 지연 이벤트는 사례에 추가하지 않고 원본 이벤트는 보존한다. [계획·검증 기록](docs/faq-question-examples-plan.md)을 참고한다.

결제 승인 복구는 새 앱 전에 migration 051을 적용한다. 미확정 요청을 선택할 때 다음 자동 조회를 1분 뒤로 예약해 다른 요청의 확인 기회를 보장한다. 확정 실패만 해제하고 새 결제 시도별 멱등키를 사용하며, 타임아웃·404·인증 오류는 결제키를 보존한다. [결제 연동 계약](../docs/api/order-payment-integration.md)의 실패·복구 기준을 따른다.

AI 상담 성능 대시보드는 [프론트 조회 명세](docs/ai-dashboard-frontend-integration.md)와 [AI 전송 명세](docs/ai-dashboard-ai-integration.md)를 따른다. 새 앱 전에 migration 050을 적용한다. 고객 전체·신규·기존 공통 필터로 GET 4개를 제공하고, AI가 기존 analysis 저장 후 이탈·응답 대기 지표를 각각 전송한다. 페르소나 막대는 현재 운영 버전과 직전 활성 버전만 비교하며 활성화 성공 시 직전 번호를 보존한다. 신규 지표는 통화 soft delete·최초 수신부터 5년 폐기를 따른다. 기존 분석 요청 형식은 유지하고 불편 유형 5개를 추가한다. [계획·검증 기록](docs/ai-dashboard-plan.md)의 운영 배포·과거 이력 제한도 확인한다.

미답변 사유는 [사유 연동 계약](docs/unanswered-question-reasons.md)을 따른다. 새 앱 전에 migration 049를 적용한다. 기존 질문별 수집 POST의 선택 `reason`에 `KB_NO_ANSWER`·`KB_UNAVAILABLE`을 받고 생략/null·과거 행은 미분류로 보존한다. 목록의 reason 필터와 조회 전용 `status=ALL`로 삭제되지 않은 OPEN·REGISTERED 발생을 집계하며 기본 OPEN은 유지한다. 통화 처리 결과는 `unansweredReason`으로 제공한다. AI의 실제 답변 대조와 운영 적용은 별도다.

수거 요청 시각은 결제 대기 중에도 보존하고, 요청 시각까지 결제하면 유지한다. 이후 결제 또는 미전송 시 결제 완료 + 1시간을 한국시간 09:00~17:00으로 조정한다(17시 초과는 다음날 09시). AI 입력 시각에는 별도 영업시간 제한을 두지 않는다. [AI 통화 후속 연동 변경](docs/ai-call-follow-up.md)의 최신 계약을 따른다.

콜백 요청 여부는 기존 최종 분석 POST의 선택 필드 `hasCallbackRequest`로 받고, 통화 목록·상세의 `analysis`에 반환한다. 새 앱 전에 `048-call-callback-request.sql`을 적용한다. 기존 데이터는 null이며 별도 콜백 접수·처리 완료 API는 추가하지 않는다.

AI 고객 기본 주소 PATCH는 `call_session_seq`로 진행 중 본인 통화를 확인한다. 개인 PIN의 추가·수정은 해당 통화 고객에 한해 종료 후에도 가능하며 목록 조회는 기존 진행 중 조건을 유지한다. 관리자 세션·Origin과 삭제·보관·소유권·감사 트랜잭션은 유지한다. AI의 주소 수정 헤더 전송을 새 백엔드 배포 전에 반영해야 한다.

미사용 계약 제거는 [AI·프론트 전달 및 DB 전환 안내](docs/unused-contract-cleanup.md)를 따른다. 새 앱 전에 migration 047을 백업 후 적용한다. 중복 관리자 권한·AI FAQ 상세 API와 레거시 통화 종료 사유·연결 기록을 제거하며 실제 상담원 연결 요구 요약은 유지한다.

디버 접수는 [10초 응답 제한·10분 자동 재시도 계약](docs/order-submission-retry.md)을 따른다. 새 앱 전에 migration 046을 적용한다. SUBMITTING_FAILED는 최초 전송 후 10분 안의 자동 재시도 중 실패, SUBMISSION_FAILED는 자동 재시도가 끝난 최종 실패다. AI·프론트의 상태 분기와 실패 탭 표시는 이 계약을 따른다.

업무 데이터 삭제·보관은 새 migration 045와 [작업 명세](docs/data-retention.md), [API·AI 전달 사항](docs/data-retention-handoff.md)을 따른다. 기존 업무 DELETE는 soft delete로 바꾸고 주문·통화 DELETE를 추가한다. 통화 전체(녹취·STT·AI 이벤트)는 최초 incoming_at부터 5년, 주문은 최초 완료/취소(미완료는 생성)부터 5년 후 실제 폐기한다. 감사 로그와 전송 완료 알림은 7일 정리한다. 045 한 번 적용 후 새 앱으로 전환하며 [인프라 후속 항목](docs/data-retention-infra-follow-up.md)의 S3 권한·외부 로그·백업 폐기를 함께 확인한다. 외부 문서의 과거 물리 삭제 설명보다 이 계약을 우선한다.

진행 통화 수는 `GET /api/calls/active-count`, 변경 구독은 `GET /api/calls/active-count/stream`으로 제공한다. 새 앱 전에 044 migration을 적용한다. 과거 종료 미확인 통화는 제외하고 새 등록부터 집계하며 PBX 종료를 녹취 업로드 전에 반영한다. 관리자 쿠키·부하별 전송 묶기·세션 재검증과 양쪽 nginx 설정·운영 적용 순서는 [실시간 통화 수 계약](docs/active-call-count.md)을 따른다. nginx 설정은 저장소에 반영했으며 실제 서버 적용은 별도다.

무의미 통화는 AI가 등록·업무 결과 전송을 생략한다. 최초 고객 확인은 phoneNumber만 보내 조회하고, 업무 의도를 확인한 뒤 같은 API에 최초 call(providerCallId·incomingAt)을 보내 통화를 등록한다. PBX 미연결 수신은 received_at부터 30분 경과 후 처리 주기에 삭제하며 S3 미설정이어도 정리는 실행한다. 연결된 유효 통화의 저장 실패와 NO_ORDER는 보존한다. [AI 전달 계약](docs/meaningful-call-registration-handoff.md)을 따르며 AI 코드·운영 배포는 별도다.

주소 위도·경도는 모든 입력·출력·디버 전송에서 제거한다. 고객·사원·PIN의 JSON 주소와 주문 좌표 컬럼은 새 migration 043으로 정리하며 기존 주문·PIN 버전과 나머지 값은 보존한다. 기존 앱 중지·백업 후 전환하고 구버전 앱으로 이미지 단독 복귀하지 않는다. 사용자 지정 범위에 따라 `backend/` 밖 문서·배포 보호는 수정하지 않았으므로 [좌표 제거 계약과 전환 주의사항](docs/address-coordinates-removal.md)을 우선한다.

통화별 AI 요약은 [ANL-01](../docs/api/call-analysis.md)을 따른다. `isNewCustomer`, `registeredParcelCount`, `faqAnswerCount`, `orderLookupCount`, `cancelledParcelCount`, `hasHandoffRequest`를 추가하고 실제 사용 `aiPersonaVersionSeq`도 AI가 전달한다. 접수·취소는 배송 상세 기준이며 접수에 결제 대기를 포함한다. 백엔드는 검증·저장·조회만 담당한다. 새 앱 실행 전에 migration 041·042를 적용한다. 042는 대표 분류 result를 삭제하고 기존 재전송 해시를 갱신하므로 기존 백엔드 중지·백업 후 전환한다. AI의 result 전송·프론트의 analysis.result 표시와 result 목록 필터를 제거해야 한다. 과거 요약은 null, result를 제거한 동일 재전송은 204, 다른 최종값은 409이며 프론트는 기존 통화 목록·상세의 analysis에서 조회한다.

기업 공유 배송지는 활성 기업 사원의 현재 고객 주소로 조회하며 DIR-01은 AI_BUSINESS_TOKEN Bearer 전용이다. 관리자 상단바는 세션 전용 [사원 검색](../docs/api/company-members-search.md)을 사용하며 주소 없는 사원과 선택적 비활성 검색을 지원한다. 두 검색 q는 정규화 후 1~100자다. 기업 PIN API는 폐기하며 053 migration으로 company_pins를 제거한다. 개인 PIN·과거 주문 주소/COMPANY 논리 참조·감사는 보존하고 companyPins는 빈 배열로 유지한다. [기업 검색 계약](../docs/api/company-directory.md), [제거·배포·복구 안내](docs/company-pin-retirement.md), [AI 인계](docs/company-address-directory-handoff.md)를 따른다. AI/FE 코드·운영 배포는 별도이며 053 없는 구버전 이미지로 단독 복귀하지 않는다.

통화 고객 번호는 nullable 논리 참조로 저장한다. 고객이 없어도 통화를 보존하며 전화번호 변경 후에도 통화·미답변의 고객 연결을 유지한다. 새 앱 전에 migration 040이 필요하다. 기존 데이터 보완과 연동 범위는 [통화 고객 연결](docs/call-customer-reference.md)을 따른다.

페르소나 목록·상세·버전 이력은 모든 ACTIVE 관리자에게 조회를 허용한다. 생성·수정·publish와 AI 지원 옵션은 ACTIVE인 SUPERVISOR(개발자)·SYSTEM_ADMIN에게 허용한다. 주문 결제수단을 생략하면 미정(null)으로 저장·조회하며 최종 접수 전에는 선택해야 한다. 새 앱 전에 migration 039·040을 모두 적용한다. 주문 정보가 전혀 없는 AI 미완료·취소 결과는 통화와 재전송 식별자만 보존하고 NO_ORDER를 반환한다. 기존 결제수단과 주문은 유지하며 실제 서버 DB 적용은 별도다. 프론트의 권한·null 표시 연결은 [전달 사항](docs/persona-read-payment-null-handoff.md), AI의 주문 미생성 응답은 [빈 통화 계약](docs/empty-ai-order-results.md)을 따른다.

백엔드 최적화 브랜치는 새 앱 실행 전에 `032-list-read-indexes.sql`까지 적용한다. 031은 녹취 처리의 수신 건별 lease, 032는 검증된 조회 인덱스 두 개를 추가하며 API 형식은 바꾸지 않는다. 구버전 앱으로 복구할 때 추가 컬럼·인덱스는 보존해도 된다. 단계별 검증·보류 사항은 [최적화 기록](docs/backend-optimization.md)에 정리한다.

AI 통화 분석 ANL-01은 [분석 계약](../docs/api/call-analysis.md), 이벤트 수집 EVT-01은 [이벤트 계약](../docs/api/call-events.md)을 따른다. 현재 앱 실행 전에는 FAQ 분류·고객 내 주소·선택 부서를 포함해 028까지 적용한다. 통화 위치는 offsetSeconds(정수 초)이며 AI 동작 status는 받지 않는다. 프론트는 [발화·처리 결과·AI 동작 조회](../docs/api/call-events-read-spec.md)를 각각 사용한다. 신규 업무 검색 코드는 PIN_SEARCH·PREVIOUS_ORDER_SEARCH이며 주소에 한정하지 않는다. FAQ_ANSWERED는 사용 FAQ와 같은 통화의 질문·답변 발화를 연결한다. 조회 분리에는 추가 migration이 없다.

AI 미답변 질문은 [UNQ-01 계약](../docs/api/unanswered-questions.md)에 따라 POST /api/ai/unanswered-questions로 수집한다. 같은 AI_INSIGHTS_TOKEN을 사용하며 최초 201·동일 발생 재전송 200이다. 신규 상태는 OPEN, 위치는 정수 초 또는 null이다. 프론트의 목록·검색은 [UNQ-02](../docs/api/unanswered-questions-read-spec.md) GET /api/unanswered-questions를 사용한다. 관리자 세션 전용, 기본 OPEN, 오래된 통화부터 조회하며 기간은 PBX 우선·AI 분석 대체의 통화 시작 기준이다. 전환·삭제는 [UNQ-03·UNQ-04](../docs/api/unanswered-questions-management.md)를 따른다. 전환은 분류·질문·답변 모두 필수이며 원문과 재전송 이력은 보존한다. 새 앱 전에 028까지 적용한다. 목록의 total_count로 검색 총건수를 제공하며 통계 뷰는 후속 작업이다.

기업·부서 soft delete, 소속 해제와 PIN 숨김, 개인 회원·주문·통화·녹취·청구 이력 보존은 [최신 삭제 계약](docs/data-retention-handoff.md)을 따른다. 기존 URL·권한·트랜잭션 범위는 [기존 삭제 API 계약](../docs/api/company-deletion.md)을 유지한다. 새 앱 전에 045까지 적용한다. 운영 DB 적용·삭제는 별도이며 AI 폴더는 변경하지 않는다.

FAQ 단건·복수 추가/삭제와 단건 수정은 [FAQ API](../docs/api/faqs.md), AI 수신 API 구현은 [별도 AI FAQ 연동 규격](../docs/api/ai-faq-integration.md)을 따른다. 027 migration 적용 후 새 앱을 실행한다. 추가·수정은 category·question·answer가 모두 필수다. 관리자 조회에만 분류를 제공하고 AI 원본 응답·알림 형식은 유지한다. 기존 32개 질문은 [분류표](../docs/database/faq-category-assignments.md)대로 보완하며 미등록 질문이 있으면 임의 분류 없이 migration을 중단한다. 실제 DB 적용은 이번 작업에서 제외한다. `AI_FAQ_TOKEN`을 설정하면 저장된 변경 알림을 AI에 전송하며, 비어 있으면 대기는 보존하고 전송만 비활성이다.

부서 관리·구성원 배정·개인/기업 월결제 및 부서 그룹결제 설정은 [부서와 결제 자격](../docs/api/departments.md)을 따른다. 구성원의 부서 번호는 선택이며 부서 없는 기업도 직원 등록·기업 월결제를 사용할 수 있다. 새 앱 전에 028까지 적용한다.

주문 전체·상세 단건/복수 취소와 취소 후 조회·접수 규칙은 [주문 취소 API 계약](../docs/api/order-cancel.md)을 참고한다. 승인 대기 없이 결제 전 주문을 내부 DB에서 처리하며 디버 취소 연동은 포함하지 않는다.

페르소나 유형·초안·버전·적용은 [HEAD·publish 관리 계약](docs/persona-head-management.md)을 우선한다. 새 앱 전에 039 migration까지 적용한다. PATCH 수정 저장은 유형별 초안 한 개를 덮어쓰고 HEAD를 유지한다. POST versions가 초안을 정식 버전으로 확정하고 초안을 삭제하며, POST activate가 확인한 HEAD를 별도로 publish한다. 확정과 publish는 실제 상담·기존 대기를 구분한다. 프론트는 expectedDraftRevision과 초안 응답을 처리하고 HEAD 확정 호출을 추가해야 한다. 신·구 PATCH 계약의 앱을 동시에 운영하지 않는다. 수동 PUT head는 계속 제공하지 않는다. 통화 중 적용과 선택 호환값 activeCallCount는 [다음 통화 적용 AI 전달 명세](docs/ai-persona-next-call.md)를 따른다. 진행 중 통화의 버전 고정은 AI 팀 구현·검증이 필요하다. `AI_PERSONA_TOKEN` 미설정 또는 AI 옵션 API 미연결 시 저장·확정·publish 요청은 503이다.

관리자 페르소나 응답의 `createdByAdminUserName`은 045에서 추가한 스냅샷으로 조회한다. 기존 감사 기록·관리자 정보로 확인 가능한 이름만 보완하고 알 수 없으면 null이다. 관리자 삭제·로그 7일 정리 후에도 생성 후 5년까지 이름을 유지하며 AI 설정 응답에는 이름을 추가하지 않는다. 주문 생성자 권한도 별도 논리 참조로 보존해 로그 TTL에 의존하지 않는다.

관리자 통화 목록·상세·발화 조회는 [통화·녹취 API 계약](../docs/api/calls.md)을 참고한다. 목록의 q·hasComplaint·aiPersonaVersionSeq와 고객 표시, 목록·상세의 저장된 analysis를 제공한다. 분석 미수신은 null이며 PBX 시각·기간·정렬과 녹취 재생 동작은 유지한다. 기존 두 GET 조회에 요약을 추가하고 대표 분류·필터 result를 삭제한다. 목록의 total_count가 검색 총건수를 제공한다. 담당 2용 통계 뷰는 남은 작업이다.

기업 구성원·대표자 표시·소속 해제·JSON 단건/복수 등록/갱신은 [구성원 API 계약](../docs/api/members.md)을 참고한다. 이름·전화번호 등록의 선택 role과 기업·선택 부서·사원 통합 등록의 최신 입력·트랜잭션 계약은 [기업·사원 등록 명세](docs/company-registration.md)를 우선한다.

고객 등록·목록·상세·수정의 MVP 범위와 AI 호출 방법은 [고객 API 계약](../docs/api/customers.md)을 참고한다.

기업명·상태 관리 기능의 세션 인증 계약과 Postman 확인 방법은 [기업 API 계약](../docs/api/companies.md)을 참고한다.
AI는 [주문 API 계약](../docs/api/orders.md)에 따라 POST /api/orders에 상담 결과를 한 번 전달한다. COMPLETE는 개인 카드 결제 대기 또는 월·그룹결제 완료 후 디버 접수 결과를 반환하고, INCOMPLETE·CANCELLED는 일부라도 수집한 주문을 저장한다. 주문 데이터가 없는 통화는 [빈 통화 계약](docs/empty-ai-order-results.md)에 따라 주문을 생성하지 않는다. 기존 미완료 주문 보완 후 접수는 [ORD-06](../docs/api/order-submit.md)을 유지한다.
상담 시작의 [고객 확인 API](../docs/api/caller-context.md)는 먼저 phoneNumber만 보내 조회한다. AI가 실제 업무 의도를 확인한 뒤 최초 call(providerCallId·incomingAt)을 추가해 통화를 생성·재사용한다. 응답의 callSessionSeq를 상담 중 주문 조회·취소·주소록 API의 call_session_seq 헤더로 보내고, 주문 결과는 같은 통화에 연결한다. 무의미 통화는 등록·결과 전송을 생략한다. 새 두 단계 계약은 위 AI 전달 문서를 우선한다.
PBX 수신함 저장 후 유일한 통화의 종료를 즉시 반영하고 S3·recordings 연결은 비동기로 처리한다. 즉시 매칭이 실패하면 기존 워커가 재시도한다. 미연결 수신은 30분 경과 후 정리하며 연결된 통화는 보존한다. 최신 [실시간 통화 수 계약](docs/active-call-count.md)과 기존 [AI·PBX 연동 명세](../docs/api/ai-pbx-recordings.md)·[S3 설정](../docs/api/recording-s3-setup.md)을 참고한다.

Jira: [S15P31D109-134](https://ssafy.atlassian.net/browse/S15P31D109-134). Node.js 24, NestJS 11, PostgreSQL 17, `pg`를 사용한다.
업무 API의 초기 계약은 팀이 제공한 API 명세 초안을 따른다. MSA 애플리케이션과 독립적으로 관리한다.

NestJS 11 호환성을 유지하면서 전이 의존성의 알려진 DoS 취약점을 수정하기 위해 overrides로
multer 2.5.0, body-parser 2.4.0, js-yaml 5.5.0을 지정한다. 상위 패키지가 수정 버전을 포함하면 override 제거 여부를 검토한다.
Swagger 12는 NestJS 12를 요구하므로 이번 기반에서 프레임워크 major를 올리지 않는다.

결제·부서·부분 취소는 [현재 주문 결제 계약](../docs/api/order-billing.md)을 따른다. AI 담당자용 별도 [연동 규격](../docs/api/ai-order-billing-integration.md)을 제공한다. 기존 migration은 수정하지 않고 016~019까지 적용해야 한다. 실제 결제사 승인·결제 URL·카카오톡 발송은 추후 확정한다.

## 로컬 실행

```sh
cd backend
npm ci
# Windows PowerShell: Copy-Item .env.example .env.development
cp .env.example .env.development
# .env.development의 개발 DB 접속 정보와 AI_AGENT_URL을 설정한다.
npm run start:dev
```

개발 전용 PostgreSQL을 사용한다. DB 포트가 로컬에 없으면 `compose.yaml`로 전체 서비스를 실행하거나
팀 개발 DB/SSH 터널의 주소를 사용한다. 운영 DB를 테스트 대상으로 지정하지 않는다.
업무 스키마는 기존 `infra/database/migrate.sh`와 `backend/migrations/`로 별도 적용한다.
현재 앱 시작 시의 기존 PBX 수신 테이블 생성(001)은 유지하며, 업무 migration 자동 적용이나 ORM schema sync는 추가하지 않는다.

`NODE_ENV`를 실행 환경에 지정하면 development는 `.env.development` → `.env`, test/production은 주입한 환경변수만 읽는다.
실행 환경변수는 파일보다 우선한다. `NODE_ENV` 기본값은 development다.
파일에서 `NODE_ENV`를 바꾸어 환경 선택에 의존하지 않고 실행 시 지정한다.

| 설정 | 규칙 |
|---|---|
| `NODE_ENV` | development / test / production |
| `SECURITY_LOG_HMAC_KEY` | backend 전용 32바이트 난수의 64자리 hex. production 필수; development/test 미설정은 프로세스 임시 키 |
| `PORT`, `DB_PORT` | 정수 1~65535, 기본 3000 / 5432 |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | 필수, 누락/빈 값이면 시작 중단 |
| `AI_AGENT_URL` | 필수 HTTP(S) URL. 기존 readiness가 AI 연결까지 확인한다. 자격정보·query·fragment 금지 |
| `AI_BUSINESS_TOKEN` | 선택, 고객 확인·등록·상세·수정 전용 32자 이상 공백 없는 ASCII 토큰. 미설정 시 해당 AI 호출은 503. 관리자 세션은 유지 |
| `AI_PERSONA_TOKEN` | 선택, AI 서버와 공유할 32자 이상 공백 없는 ASCII 토큰. 페르소나 옵션·알림·설정 조회·적용 회신 전용. 비어 있으면 해당 연동과 재시도 워커만 비활성 |
| `AI_FAQ_TOKEN` | 선택, 32자 이상 공백 없는 ASCII 토큰. FAQ 변경 알림 전용. 비어 있으면 FAQ 쓰기·알림 대기는 보존하고 전송 워커만 비활성 |
| `AI_INSIGHTS_TOKEN` | 선택, 통화 분석·이벤트·미답변 수집 전용 32자 이상 공백 없는 ASCII 토큰. 미설정 시 ANL-01·EVT-01·UNQ-01은 503 |
| `CORS_ORIGINS` | 정확한 origin을 쉼표로 구분. 예: `http://localhost:5173,https://13.209.59.180`. 경로·와일드카드 금지 |
| `SWAGGER_ENABLED` | true / false. 개발 기본 true, 테스트·운영 기본 false |
| `PBX_WEBHOOK_TOKEN` | 선택, 설정하면 공백 없는 32바이트 이상 토큰. 미설정 시 PBX 수신은 기존대로 503 |
| `DVER_API_URL` | 기본 `https://public-n8n.dvercorp.co.kr:47514/webhook/parcel`. HTTPS, 자격정보·query·fragment 금지. test에서만 로컬 HTTP 모의 서버 허용 |
| `DVER_API_KEY` | 서버 전용 디버 키. 빈 값이면 신규 최종 접수만 503. 공백·제어문자 금지. Compose가 backend에 전달 |
| `AWS_REGION` | S3 대상 리전. 기본 ap-northeast-2 |
| `S3_RECORDINGS_BUCKET` | 비공개 녹취 버킷명. 미설정이면 업로드만 비활성. 미연결 PBX 수신의 30분 정리는 계속 실행 |
| `RECORDING_ALLOWED_HOSTS` | 정확한 원본 다운로드 호스트 목록. 기본 디버 녹취 S3 호스트, 쉼표 구분 |
| `RECORDING_MATCH_WINDOW_SECONDS` | 동일 발신번호의 OpenAI/PBX 시작 시각 허용 차이. 기본 ±30초, 1~300 |

AWS 자격 증명은 SDK 기본 체인을 사용한다. 역할이 없는 환경은 배포 비밀의 `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`·필요 시 `AWS_SESSION_TOKEN`을 Compose로 주입한다. 새 앱 실행 전 011 migration이 필요하다. 기존 테이블에 연결·재시도 컬럼만 추가하며 새 업무 테이블은 없다.

설정 검증 오류에는 변수 이름만 출력하고 값은 출력하지 않는다. 실제 `.env*`는 Git에서 제외하고 `.env.example`만 관리한다.
관리자 인증은 PostgreSQL 서버 세션을 사용한다. JWT 비밀키는 필요하지 않으며 관리자 비밀번호를 환경 파일에 저장하지 않는다.

## 구조와 역할

```text
src/
  config/                  # 실행 환경 검증
  database/                # Pool 수명주기, 트랜잭션, DatabaseModule
  common/
    dto/                   # 공통 요청·응답 DTO
    errors/                # ApiException 및 오류 코드
    http/                  # 전역 검증·응답·예외·요청 추적
    pagination.ts
  health/                  # 기존 liveness/readiness
  webhooks/pbx/            # 기존 PBX controller/service/repository
  configure-application.ts # HTTP 공통 설정, 테스트도 같은 함수 사용
```

신규 업무는 `src/<업무>/`에 Module·Controller·Service·Repository·dto를 배치한다.
Controller는 HTTP/DTO, Service는 업무 규칙과 트랜잭션 경계, Repository는 매개변수화 SQL을 담당한다.
HTTP 계층에서 SQL을 실행하거나 범용 BaseRepository에 모든 업무를 넣지 않는다.

DatabaseModule을 가져오면 DatabaseService를 주입할 수 있다. 단순 쿼리는 `database.pool.query(sql, values)`를 사용한다.
여러 저장을 묶을 때는 다음처럼 같은 PoolClient를 모든 Repository에 전달한다.

```ts
await database.transaction(async (client) => {
  await repository.save(input, client);
  await auditRepository.record(event, client);
});
```

Repository의 `client` 인수는 PoolClient로 선언하고 전달받은 client에서 쿼리한다.
트랜잭션 내부에서 `pool.query`를 호출하면 다른 연결을 사용할 수 있으므로 사용하지 않는다.
성공하면 COMMIT, 예외면 ROLLBACK하며 연결을 반환한다. 롤백 자체가 실패하면 연결을 폐기하고 최초 예외를 유지한다.
외부 HTTP 응답을 기다리는 동안 DB 트랜잭션을 유지하지 않는다.

## 팀 백엔드 구조 컨벤션

`backend/`는 업무별 모듈로 책임을 구분하되 하나의 NestJS 애플리케이션으로 실행·배포하는
모듈형 모놀리식이다. 아래 구조는 신규 API 개발 기준이며, 아직 구현하지 않은 업무 폴더를 포함한다.
각 기능을 구현할 때 필요한 파일만 추가하고 빈 폴더나 공통 추상 클래스를 미리 만들지 않는다.
MSA의 내부 코드를 직접 가져오거나 MSA 배포 구조에 맞춰 모놀리식 모듈을 나누지 않는다.

### 전체 폴더 계층

```text
backend/
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── configure-application.ts
│   ├── config/                 # 실행 환경 검증
│   ├── database/               # Pool·트랜잭션 관리
│   ├── common/                 # 공통 DTO·오류·HTTP 처리·페이지네이션
│   ├── health/                 # 기존 liveness/readiness
│   ├── webhooks/
│   │   └── pbx/                # 기존 PBX 수신
│   ├── auth/                   # 로그인·인증·권한
│   ├── admins/                 # 관리자 계정 관리
│   ├── customers/              # 개인 고객·개인 주소록
│   ├── organizations/          # 기업·소속 직원·기업 주소록
│   ├── orders/                 # 주문·주문별 택배 상세
│   ├── consultations/          # 통화·대화·녹취·상담원 연결
│   ├── deliveries/             # 배송·배송 상태 이력
│   ├── ai-settings/            # AI 페르소나·프롬프트 버전
│   ├── faqs/                   # FAQ 관리
│   └── audit/                  # 업무 감사 기록
├── migrations/                 # SQL 마이그레이션
├── test/                       # node:test 기반 테스트
├── database-tests/             # 스키마 검증
└── scripts/                    # 검증 실행 도구
```

업무 모듈은 `src/<업무>/`에 둔다. 중간에 `modules/`, `domains/`를 추가하거나
최상위 `controllers/`, `services/`, `repositories/`로 모든 업무 파일을 모으지 않는다.
`common/`에는 여러 업무에서 실제로 공유하는 요소만 두고 특정 업무의 상태 전이나 계산 규칙은 해당 모듈에 둔다.
인증 Guard처럼 소유 업무가 명확한 코드는 여러 곳에서 사용하더라도 소유 모듈에서 관리한다.

### 업무 모듈과 데이터 책임

[모놀리식 ERD](../docs/database/monolith.dbml)의 업무·운영 테이블을 다음 기준으로 묶는다.
테이블마다 Module을 만들지 않고 함께 변경되는 데이터와 업무 흐름을 기준으로 구분한다.

| 모듈 | 담당 데이터·책임 |
|---|---|
| `customers` | `customers`, `personal_pins` |
| `organizations` | `organizations`, `departments`, `memberships`, `organization_billing_months`, `order_billing_charges` |
| `orders` | `orders`, `order_parcels` |
| `consultations` | `call_sessions`, `call_utterances`, `recordings` |
| `deliveries` | `shipments`, `shipment_status_history` |
| `admins` | `admin_users` 계정 관리 |
| `auth` | 로그인·인증·권한 검사. 계정 접근은 `admins`가 공개한 기능 사용 |
| `ai-settings` | `ai_personas`, `ai_prompt_versions` |
| `faqs` | `faq_entries`, `faq_change_notifications` |
| `audit` | `audit_logs` |

기존 `webhooks/pbx/`의 수신 저장과 `consultations`의 업무 처리는 구분한다.
이 컨벤션만으로 기존 웹훅 경로·응답·중복 처리나 저장 테이블을 변경하지 않는다.

### 모듈 내부 파일과 역할

```text
orders/
├── orders.module.ts
├── orders.controller.ts
├── orders.service.ts
├── orders.repository.ts
├── orders.types.ts             # 여러 파일이 공유하는 업무 타입이 있을 때만
└── dto/
    ├── create-order.dto.ts
    ├── update-order.dto.ts
    ├── list-orders-query.dto.ts
    └── order-response.dto.ts
```

DTO 이름과 필드는 실제 API 명세에 맞춘다. 위 예시는 수정 API 등의 구현을 강제하지 않는다.
파일·폴더 이름은 소문자 kebab-case, 클래스 이름은 PascalCase와 역할 접미사를 사용한다.
예: `orders.service.ts`의 `OrdersService`, `create-order.dto.ts`의 `CreateOrderDto`.

| 구성 요소 | 책임 |
|---|---|
| Module | 의존 모듈 imports, Controller·Provider 등록, 외부에 필요한 기능만 exports |
| Controller | 경로·HTTP 상태 코드·요청 DTO·Swagger 정의, Service 호출과 결과 반환 |
| Service | 업무 규칙·상태 전이·수정 가능 여부·동시 수정 검증, 처리 순서와 트랜잭션 경계 |
| Repository | 매개변수화 SQL, DB 조회·저장·필요한 JOIN |
| DTO | 외부 입력의 런타임 검증과 응답 계약. DB 행을 그대로 노출하지 않음 |
| 업무 타입 | 여러 파일이 공유하는 내부 타입. DB 조회 결과 전용 타입은 Repository 내부에 둘 수 있음 |

이 프로젝트는 `pg`로 SQL을 직접 실행하므로 DB를 사용하는 업무는 처음부터 Repository를 둔다.
Controller나 Service에 SQL을 넣지 않고, ORM용 `entities/`나 범용 BaseService·BaseRepository를 추가하지 않는다.
값의 형식 검증은 DTO·Pipe, 현재 데이터에 따른 업무 판단은 Service에 둔다.
예를 들어 정수 범위 검증과 이미 접수된 주문의 수정 허용 여부는 각각 다른 책임이다.

작은 모듈에서는 Controller·Service·Repository 파일을 모듈 바로 아래에 둔다.
파일 하나를 담기 위한 `controllers/`, `services/`, `repositories/` 폴더를 만들지 않는다.
Service 분리는 줄 수보다 업무 책임을 기준으로 한다. 주문 생성과 취소가 각각 복잡해지면
`order-creation.service.ts`, `order-cancellation.service.ts`로 나누고 Controller에서 직접 주입받을 수 있다.
단순 전달만 하는 중간 Service를 유지할 필요는 없다.

하위 업무에 관련 파일이 늘어나면 다음처럼 묶는다.

```text
customers/
├── customers.module.ts
├── customers.controller.ts
├── customers.service.ts
├── customers.repository.ts
├── dto/
└── personal-pins/
    ├── personal-pins.controller.ts
    ├── personal-pins.service.ts
    ├── personal-pins.repository.ts
    └── dto/
```

하위 폴더가 반드시 별도 Module을 의미하지는 않는다. 우선 `CustomersModule`에 등록하고,
독립적인 의존 관계와 공개 범위가 필요해질 때 별도 Module로 분리한다.

### 모듈 간 의존 관계와 트랜잭션

- 다른 업무의 상태 확인·변경은 그 모듈이 공개한 Service를 사용한다.
  예: `OrdersService → CustomersService → CustomersRepository`.
- 사용하는 Module을 imports하고 공개된 Provider를 주입받는다.
  다른 모듈의 Service를 자신의 providers에 다시 등록하지 않는다.
- Repository는 기본적으로 모듈 내부 구현으로 유지한다. 다른 모듈의 테이블을 직접 수정해 업무 규칙을 우회하지 않는다.
  감사 기록도 다른 업무에서 AuditRepository를 직접 주입하는 대신 AuditService가 공개한 기능을 사용한다.
- 목록·상세 응답을 위한 읽기 전용 JOIN은 해당 조회 API의 Repository에서 처리할 수 있다.
  이 경우에도 접근 권한과 개인정보 노출 범위를 지키며, JOIN 결과를 이용해 소유 모듈의 변경 규칙을 우회하지 않는다.
- 여러 모듈의 저장이 하나의 트랜잭션에 참여해야 하면 흐름을 주도하는 Service가 트랜잭션을 연다.
  참여하는 공개 Service와 Repository를 통해 동일한 `PoolClient`를 전달한다.
  참여 Service가 별도 트랜잭션이나 `pool.query`로 연결을 바꾸지 않는다.
- 모듈 간 순환 참조가 생기면 처리 흐름의 주체와 책임을 먼저 조정한다.
  순환 참조 해소를 위해 업무 코드를 무조건 `common/`으로 옮기지 않는다.

단일 모듈의 저장도 위의 DB 트랜잭션 규칙을 따른다. 배송 상태와 상태 이력처럼 함께 성공해야 하는
변경은 같은 트랜잭션으로 저장하고, 외부 디버 API 통신 중에는 트랜잭션을 유지하지 않는다.

### 공통 기반 재사용과 테스트 배치

신규 API는 기존 `configureApplication`, `PaginationQueryDto`, `ListResponse`, `ApiException`을 사용한다.
모듈별로 `/api` 접두사, 응답 envelope, 예외 필터, 페이지네이션, DB Pool을 다시 구현하지 않는다.
기존 health·PBX 예외 경로와 응답 계약은 유지한다. 세부 응답 형식은 아래 API 계약을 따른다.

현재 테스트는 Jest가 아닌 `node:test`와 `test/*.cjs`를 사용한다. 같은 방식을 유지한다.

주문·AI 설정 통합 테스트는 기존 `*.integration.test.cjs`가 공유 fixture를 한 번 만들고
`orders-*.cjs`, `ai-settings-*.cjs`의 시나리오 등록 함수를 원래 순서대로 호출한다.
이 등록 파일은 단독 실행 진입점이 아니다. 새 등록 파일은 기존 진입점에 require로 연결하고,
새 테스트 진입점을 추가할 때는 package.json의 실행 목록에도 연결한다.
반복문으로 등록하는 동시성 테스트도 같은 실행 순서를 유지한다.

```text
test/
├── config.test.cjs
├── http-foundation.test.cjs
├── orders.service.test.cjs          # 추가 예시: 업무 규칙
├── orders.http.test.cjs             # 추가 예시: 입력·응답·권한 계약
└── orders.integration.test.cjs      # 추가 예시: 실제 DB·트랜잭션
```

변경 내용에 필요한 테스트만 추가한다. 현재 `package.json`의 test·test:integration은 파일을 명시적으로
나열하므로 신규 테스트를 해당 명령에도 연결한다. HTTP 테스트도 `configureApplication`을 사용하고,
DB 테스트는 기존 격리 환경에서 필요한 업무 마이그레이션을 적용한 뒤 실행한다.
공통 코드 변경 시 기존 정상 경로와 PBX 회귀 검증도 수행한다.

Jenkins는 [테스트 정리 결과](docs/ci-test-cleanup.md)에 따라 구형·중복 검증을 제거하고, [영향 범위](docs/test-cleanup-plan.md)에 따라 기능별 DB 회귀를 선택한다.
여러 기능 변경은 합집합을 순차 실행한다. 새 진입점이 전체 목록에서 빠지거나 중복되면 단위 검증이 실패한다.
기능 간 호출·SQL 소비 관계가 바뀌면 `scripts/integration-profile.cjs`의 영향 범위도 갱신한다.
공통 업무 fixture는 비밀번호 로그인을 반복하지 않고 임시 DB 세션을 준비하며 실제 guard는 통과한다.
인증 상세 회귀는 전체/인증 변경에서, 인증 단위·production/Nginx/HTTPS 검증은 모든 백엔드 실행에서 유지한다.
기본 `npm run check:docker`는 전체 검증이고 Jenkins `FULL_BACKEND_TESTS=true`로도 전체를 강제할 수 있다.

### 신규 API 작업 순서와 미확정 계약

1. [Git 협업 컨벤션](../docs/CONVENTION.md)에 따라 최신 `develop-backend`에서 작업 브랜치를 만든다.
2. API 명세와 [DB 마이그레이션 기준](../docs/database/README.md)을 확인하고 담당 모듈·데이터를 정한다.
3. 필요한 DTO·Controller·Service·Repository를 추가하고 Module과 AppModule에 연결한다.
4. 호출하는 모듈의 공개 기능, 권한 검사, 응답 스키마, 트랜잭션 범위를 함께 확인한다.
5. 테스트와 실행 명령을 연결하고 변경 범위에 맞는 검증 후 `develop-backend` 대상 MR을 작성한다.

폴더 구조 컨벤션은 미확정 API·인증 정책을 확정하는 근거가 아니다. 다음 차이는 관련 기능 구현 전에 확인한다.

- 현재 구현과 이 README의 신규 API 접두사는 `/api`이며 공통 기반 Jira 설명에는 `/api/v1`이 남아 있다.
  이번 구조 문서화에서는 현재 경로를 유지하며 접두사를 변경하지 않는다.
- 관리자 인증은 83번에서 서버 세션 9시간으로 확정했다. `auth_version`과 JWT는 사용하지 않는다.
- 통화 `provider_call_id`는 OpenAI 세션 ID이며 수신 이벤트 시각과 함께 전달한다. PBX는 [AI·PBX 계약](../docs/api/ai-pbx-recordings.md)의 유일 후보 매칭을 사용한다. 문장 전송·전사는 이번 범위가 아니다.

## API 계약

신규 Controller에는 `/api`가 자동으로 붙는다. Controller에 접두사를 중복 작성하지 않는다.
기존 `/health`, `/health/ready`, `/webhooks/pbx/call-ended`는 경로와 응답을 유지한다.
컨테이너 Nginx는 신규 `/api/...`를 그대로 전달한다. 기존 `/api/health`, `/api/health/ready`,
`/api/webhooks/pbx/call-ended`에만 `/api`를 제거하여 기존 백엔드 경로로 전달한다.
공개 호스트 Nginx는 `/api/...`를 컨테이너 프록시로 전달한다. AI 수신·PBX 미러 경로는 별도 운영 설정이 있으므로 저장소 파일 전체로 덮어쓰지 않는다.

| 응답 | 형식 |
|---|---|
| 단건 | Controller가 반환한 값을 `{ data, meta: { requestId } }`로 감싼다 |
| 목록 | `new ListResponse(page, limit)`에 저장소의 {rows,total_count}를 전달하면 `{ data: [], hasNext, total_count }`만 반환한다 |
| 오류 | `{ error: { code, message, details: [] }, meta: { requestId } }` |
| 204 | `@HttpCode(204)`, 본문 없음 |

성공 값에 result/code/message/timestamp를 추가하지 않는다. ListResponse는 `{rows,total_count}`를 받으며 rows는 같은 조건과 고정 정렬로 `limit + 1`개를 조회한 결과다.
저장소의 readPage는 검색·필터 SELECT와 고정 정렬을 받아 페이지와 COUNT(*)를 같은 SQL 스냅샷에서 읽는다. 검색값은 바인딩하고 SELECT에는 페이지용 LIMIT·OFFSET을 넣지 않는다.
SQL의 limit/offset은 검증된 PaginationQueryDto를 사용하고 정렬에 고유 ID를 포함한다.
기본 limit=20, 1~100, offset=0 이상 안전한 정수다. 빈 값·소수·지수 표기·반복 query·추가 속성은 400이다.
total_count는 limit·offset 적용 전 전체 건수다. 총페이지수·page 객체는 반환하지 않으며 프론트에서 ceil(total_count/limit)으로 페이지 수를 계산한다.

DTO는 런타임 class로 선언하고 class-validator 데코레이터를 지정한다. 전역 ValidationPipe는
명시적 변환만 사용하고 등록하지 않은 필드를 거절한다. 식별자·전화번호 등 문자열을 임의로 숫자로 바꾸지 않는다.
중첩 DTO는 `@ValidateNested`와 `@Type`을 지정한다. nullable과 생략 가능 여부는 업무 계약대로 개별 DTO에서 선언한다.
PATCH의 변경값 유무·업무 규칙·expectedVersion 검사는 각 업무에서 구현한다.

형식 오류는 400 INVALID_REQUEST, 업무 의미 검증은 `ApiException(422, 'BUSINESS_RULE_VIOLATION', safeMessage, details)` 등으로 구분한다.
검증 details는 필드 경로와 검증 규칙 이름만 담으며 원본 입력값을 담지 않는다.
DB UNIQUE/FK/CHECK 위반은 SQLSTATE로 분류하고 SQL·테이블명·파라미터·스택을 응답에 넣지 않는다.
ApiException에는 사용자에게 공개할 수 있는 메시지/상세만 전달한다.

X-Request-Id가 유효한 UUID면 유지하고 없거나 잘못된 값이면 새 UUID를 만든다. 모든 응답 헤더에 반환하며
API 단건/오류 meta에도 넣는다. 기업·고객 등록에는 Idempotency-Key를 요구하지 않는다. 기업명 중복은 허용하며 고객은 전화번호 UNIQUE로 중복을 거절한다. 주문 생성 키는 orders.creation_request_id에 저장하고 재시도에는 기존 주문과 현재 version을 반환한다. 최종 접수는 별도 키 없이 기존 주문 행 잠금·status로 중복 전송을 막으며 같은 주문 재호출은 상태만 반환한다. version은 수정 충돌과 최초 접수 확인용이다. 외부 웹훅·배송 이력의 기존 중복 방지는 유지한다.
요청 로그에는 method·route template·상태·소요시간·requestId만 남기고 실제 경로 ID·query·headers·body는 기록하지 않는다.
신규 API 응답은 no-store다. 인프라 로그 수집·모니터링 설정은 112번 작업 범위다.

CORS_ORIGINS는 브라우저의 정확한 scheme/host/port를 지정한다. 빈 목록은 외부 origin을 허용하지 않으며
Origin 없는 서버 간 요청의 CORS 처리는 유지한다. 관리자 변경 요청은 별도로 허용 Origin을 요구한다.
관리자는 쿠키 인증을 사용하고 CORS credentials를 허용한다. 통화 Bearer·멱등키 헤더와 request ID·Location·Retry-After 노출은 유지한다. CORS는 인증/권한 검사의 대체 수단이 아니다.

## Swagger와 자동 검증

개발 문서는 `http://localhost:3000/api/docs`, OpenAPI JSON은 `/api/docs-json`이다.
공통 ErrorResponseDto와 RequestMetaDto, 관리자 세션 쿠키 인증과 기존 서비스 Bearer 인증 정의를 제공한다.
업무 Controller의 Swagger 응답에는 전역 envelope를 포함한 최종 응답 스키마를 명시한다.

```sh
npm run lint
npm run format:check
npm test
# Docker Desktop Linux 모드 또는 Linux Docker가 필요하다.
npm run check:docker
```

Docker 검증은 checks stage에서 lint·format·설정/HTTP 테스트·컴파일을 실행하고, 이어서 임시 PostgreSQL에서
트랜잭션 커밋/롤백과 기존 PBX 중복·동시성·입력·오류·재시작 테스트를 실행한다.
운영 이미지도 실제 기동하여 개발 도구·테스트·환경 파일 제외를 검사하고, 실제 Nginx를 경유한
신규 /api 경로 보존·기존 /api 경로 변환·readiness 비공개·PBX 수신 및 운영 Swagger 기본 비활성화를 확인한다.
임시 네트워크는 internal이고 DB 호스트 포트·호스트 볼륨을 만들지 않는다. DB 데이터는 tmpfs이며 운영 DB에 접속하지 않는다.
이번 실행에서 만든 랜덤 이름의 컨테이너·네트워크·검증 이미지 태그만 정리한다. Docker build cache는 유지한다.
운영 이미지는 test·개발 도구·환경 파일을 포함하지 않는다.

Jenkins의 Backend checks 단계가 성공한 뒤에만 이미지 패키징과 배포 접근 검증으로 진행한다.
실제 Jenkins 실행 결과는 MR 반영 후 확인해야 한다. 기존 `DEPLOY_LIGHTSAIL=false` 기본값을 유지한다.

## 후속 기능

관리자 인증 AUTH-01~08은 아래 계약을 따른다. 최초 관리자는 운영자가 CLI로 직접 생성한다.
고객·주문 등 업무 API, 프론트 배포/로그인 연동, 업무 스키마 변경 및 MSA 구성은 포함하지 않는다.

## 관리자 세션 인증 — S15P31D109-83

| API | 결과 / 권한 |
|---|---|
| POST /api/auth/login | 200 `{ data: { expiresAt }, meta }`, ACTIVE만 로그인 |
| POST /api/auth/logout | 204, 현재 세션 삭제. 없는 세션도 204 |
| GET /api/auth/me | 200 `{ data: { adminUserSeq, loginId, name, role, status }, meta }` |
| GET /api/admins | SYSTEM_ADMIN, limit/offset/role/status 필터. `{ data, hasNext, total_count }` |
| PATCH /api/admins/:id | SYSTEM_ADMIN, role 변경·PENDING → ACTIVE 승인·ACTIVE ↔ INACTIVE 전환, 204 |
| POST /api/auth/signup | loginId/password/name으로 OPERATOR/PENDING 신청, 204 |
| PATCH /api/auth/password | currentPassword/newPassword/newPasswordConfirm, 204 |
| PATCH /api/admins/:id/password | SYSTEM_ADMIN, 본문 없이 dva1234로 초기화·대상 전체 세션 종료, 204 |

ID는 영문 대소문자·숫자 1~20자이고 대소문자를 구분한다. 이름은 필수이며 공백만인 값은 거절한다.
비밀번호는 최소 6자이고 별도 문자 조합·길이 상한을 두지 않으며 원문을 trim하지 않는다.
HTTP 요청 본문 크기 제한은 유지한다. 로그인·가입·비밀번호 변경 요청 제한은 사용자 결정으로 적용하지 않는다.
따라서 반복 로그인 추측과 자원 고갈 위험이 남으며 운영 확장 전에 별도 정책을 정해야 한다.

세션 토큰은 32바이트 암호학적 난수이고 쿠키로만 전달한다. DB에는 SHA-256 해시만 저장한다.
로그인 아이디·비밀번호가 맞을 때 INACTIVE는 `403 ACCOUNT_INACTIVE` / `비활성화된 계정입니다.`,
PENDING은 `403 ACCOUNT_PENDING` / `승인 대기중입니다.`를 반환하며 세션을 발급하지 않는다.
아이디가 없거나 비밀번호가 틀리면 상태와 관계없이 기존 `401 UNAUTHORIZED`를 반환한다.
프론트는 로그인 실패의 `error.code`로 안내 화면을 선택하거나 `error.message`를 표시한다.
비활성·승인 대기 계정은 로그인 성공 후 `/auth/me`로 상태를 조회하는 방식으로 처리할 수 없다.
비밀번호는 Node 내장 scrypt(N=32768,r=8,p=3)와 무작위 salt로 저장한다.
[OWASP scrypt 기준](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)을 따른다.
최초 세션 생성부터 9시간 고정 만료이며 조회로 연장하지 않는다. 재로그인 시 제출된 기존 세션을 교체한다.
만료 세션은 인증 시 거절하며 같은 관리자의 다음 로그인에서 정리한다. 별도 주기적 청소 작업은 아직 없다.

쿠키 이름은 `dva_session`, HttpOnly, SameSite=Lax, Path=/api, Domain 생략이다.
NODE_ENV=production에서는 Secure가 활성화되어 HTTPS가 필요하고 개발·테스트에서는 HTTP를 지원한다.
프론트는 `credentials: 'include'`를 사용한다. POST/PATCH 등 변경 요청에는 허용된 Origin이 필요하며 별도 보호 헤더는 요구하지 않는다.
로그인·가입·로그아웃도 허용 Origin이 필요하다. 브라우저는 자동으로 보내며 curl/Postman에서는 Origin을 명시한다.
`CORS_ORIGINS`에는 실제 프론트 origin을 정확히 등록한다. 동일 출처 배포라도 해당 origin을 등록한다.
SameSite=Lax 기준으로 동일 사이트 배포를 전제한다. 다른 사이트의 프론트와 쿠키를 공유하려면 별도 설계가 필요하다.

```ts
await fetch('/api/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ loginId, password }),
});
```

역할·계정 상태는 매 요청 DB에서 재검사한다. 신규 Controller는 전역 AuthGuard로 기본 보호되며,
`@Roles('SUPERVISOR', 'SYSTEM_ADMIN')`처럼 허용 역할을 명시한다. 역할 계층을 자동 추론하지 않는다.
업무 조회는 모든 활성 관리자, AI 설정 편집 등 제한 기능은 해당 명세의 역할을 선언해야 한다.
기존 health/PBX는 전용 경로와 기존 인증을 유지한다. 새 서비스 토큰 API에는 별도 인증 계약이 필요하다.
`@PublicAuth()`는 로그인·가입·로그아웃에만 사용하며 다른 업무에 임의로 붙이지 않는다.

AuthModule은 인증과 권한 변경의 HTTP 흐름을 소유한다. AdminAccessController도 이 모듈에서 등록하며,
계정 쓰기는 AdminsService, 감사 기록은 AuditService 공개 기능으로 위임한다. 순환 참조를 만들지 않는다.
비밀번호 변경은 대상 계정의 모든 세션 삭제·해시 갱신·감사 기록을 동일 트랜잭션으로 처리한다.
로그인도 같은 계정 잠금을 사용해 이전 비밀번호로 검증 중인 로그인이 변경 후 살아남지 않게 한다.
동시 변경은 잠금 순서에 따라 처리하며 오래된 세션의 후속 변경은 401이 될 수 있다.
이미 인증을 마친 실행 중 요청은 소급 취소하지 않는다. 두 권한 변경 경로 모두 OPERATOR ↔ SUPERVISOR만 허용한다.
SYSTEM_ADMIN을 대상으로 권한을 변경하면 403이고 SYSTEM_ADMIN으로 승격하는 입력은 400이다.
`PATCH /admins/:id`에 `role`만 전달하면 계정 상태를 유지한다. 변경된 권한은 기존 세션의 다음 요청부터 반영한다.
PENDING은 가입 대기 전용이고 ACTIVE→PENDING 변경은 허용하지 않는다.
기존 PATCH /api/admins/:id의 status로 OPERATOR·SUPERVISOR의 ACTIVE ↔ INACTIVE를 전환한다.
SYSTEM_ADMIN 본인·타인의 ACTIVE ↔ INACTIVE 전환은 403이며 기존 권한 변경·삭제 보호도 유지한다.
PENDING → ACTIVE 가입 승인은 유지하고 같은 상태 지정·PENDING → INACTIVE·PENDING으로 되돌리기는 409다.
비활성화는 계정 상태 변경·대상의 모든 세션 삭제·성공 감사 기록을 동일 트랜잭션에서 처리한다.
재활성화해도 이전 세션은 복구하지 않으므로 다시 로그인해야 한다. 이미 인증한 실행 중 요청은 소급 취소하지 않는다.

DELETE /api/admins/:id는 SYSTEM_ADMIN만 사용하며 OPERATOR·SUPERVISOR를 상태와 관계없이 soft delete한다.
SYSTEM_ADMIN은 본인·타인 모두 삭제할 수 없다. 성공 응답은 본문 없는 204이며 없는 계정은 404다.
계정에 deleted_at을 기록하고 모든 세션을 즉시 삭제해 목록·로그인에서 제외한다. 계정은 삭제 후 5년 보관하고 폐기한다. 이미 인증한 요청은 소급 취소하지 않지만 후속 인증은 실패한다.
업무 기록의 관리자 번호는 논리 참조로 보존하며 감사 로그의 actorName·targetAdminName으로 당시 이름을 확인한다.
삭제 성공 감사와 계정 삭제는 같은 트랜잭션이다. 로그인·권한 변경과 겹쳐도 계정 잠금 뒤 재검증한다.
INACTIVE는 로그인할 수 없으며 목록 필터·권한 변경·재활성화·삭제 대상으로 지원한다. 별도 상태 전환 API는 추가하지 않는다.
삭제된 loginId는 재가입에 사용할 수 있지만 adminUserSeq는 새 번호를 사용하므로 이전 기록과 연결되지 않는다.
감사 기록 범위와 AI 구분은 [감사 로그 계약](../docs/api/audit-logs.md)을 참고한다.

### DB 적용·최초 관리자 생성

앱 시작은 기존 001만 적용한다. 새 앱·관리자 CLI 실행 전 `infra/database/migrate.sh`로 015까지 적용해야 한다.
003은 기존 관리자 데이터가 없는 상태를 전제로 하며 운영 DB 적용은 이번 MR에 포함하지 않는다.
이름이 없는 기존 행이 있으면 적용이 실패하므로 데이터 보완 계획을 먼저 세운다.

첫 SYSTEM_ADMIN/ACTIVE는 운영자가 직접 만든다. 비밀번호를 명령줄 인수·소스·문서에 기록하지 않는다.
로컬 소스에서 `npm run build` 후 DB 환경변수를 주입하고 아래처럼 표준 입력으로 비밀번호를 전달한다.
PowerShell에서 입력은 화면에 표시하지 않는다. 테스트 또는 승인한 DB인지 먼저 확인한다.

```powershell
$adminPassword = Read-Host '초기 관리자 비밀번호' -MaskInput
$adminPassword | node scripts/bootstrap-admin.cjs admin 디버
Remove-Variable adminPassword
```

CLI는 SYSTEM_ADMIN이 이미 있으면 중단하고 기존 계정을 변경하지 않는다. 실제 계정은 자동 생성하지 않는다.
운영 이미지에는 scripts가 없으므로 CLI는 소스 체크아웃에서 실행한다.

### 검증

`npm run check`는 설정·공통 HTTP·비밀번호/쿠키 단위 검증을 수행한다.
`node scripts/check.cjs`는 격리 PostgreSQL에서 AUTH-01~08, 권한, Origin 검증, 만료·삭제, 동시 로그인/비밀번호 변경,
최상위 관리자 권한 보호, 감사 실패 롤백 및 기존 PBX를 검증하고 운영 이미지/Nginx의 쿠키 전달도 확인한다.
저장소 루트의 `./infra/database/test-monolith.ps1`은 migration·백업 복구·체크섬·실패 롤백을 검증한다.


모든 목록 응답의 최상위 total_count는 필수인 0 이상 정수이며 같은 검색·필터·권한 범위의 전체 결과 수다. limit·offset 적용 전 COUNT(*)를 목록 데이터와 같은 SQL 스냅샷에서 계산한다. 검색 결과 없음은 0이며 offset이 전체 건수를 넘어 data가 비어도 total_count는 유지한다. 기존 hasNext는 유지한다.

관리자 비밀번호 초기화 PATCH /api/admins/{id}/password는 본문 없이 호출하며 서버가 dva1234로 설정한다. SYSTEM_ADMIN만 가능하고 대상 전체 세션을 종료한다. 일반 비밀번호 변경은 기존 계약을 유지한다. 고객 내 주소·선택 부서에는 028 migration이 필요하고 직원 CSV 업로드는 제거되어 프론트에서 JSON을 전송한다.

관리자 주문 목록 화면은 [GET /api/admin/orders](../docs/api/admin-order-list.md)를 사용한다. 주문당 한 줄·모든 배송상세·검색 총건수를 반환하며 기존 GET /api/orders와 주문 수정 동작은 유지한다.
FAQ 등록은 단건·복수 모두 items 배열을 사용한다. 새 앱 전 029 migration으로 질문 중복을 차단하며 기존 중복이 있으면 번호를 보고하고 적용을 중단한다. FAQ_ANSWERED의 FAQ 번호는 현재 원본 존재 여부를 검사하지 않는 논리 참조다. 실제 질문·답변은 같은 통화의 저장된 발화에서 읽는다.

관리자 주문 보정은 [수정 계약](../docs/api/order-update.md)을 따른다. AI는 COLLECTING만, 관리자는 모든 상태에서 상세 추가·수정·제거를 할 수 있다. 관리자 총액은 미취소 배송비 합계로 재계산하며 결제 대기 요청을 필요 시 교체한다. 새 앱 전에 030까지 적용한다. 실제 환불·추가 결제·디버 변경 동기화·운영 DB 적용은 포함하지 않는다.

## 기업·부서 관리 화면의 사원 수와 등록일

관리자 세션으로 조회하는 다음 응답에 memberCount와 createdAt을 제공합니다.

| API | 필드 위치 |
| --- | --- |
| GET /api/companies | data[]의 각 기업 |
| GET /api/companies/{id} | data의 기업 |
| GET /api/companies/{id}/departments | data[]의 각 부서 |

- memberCount: 0 이상 정수. memberships.status가 ACTIVE인 구성원 수이며 ORG_ADMIN도 포함합니다. 기업은 부서 없는 사원도 포함하고 부서는 해당 부서의 소속만 셉니다. 기업의 운영 상태가 INACTIVE여도 구성원 상태를 별도로 집계합니다.
- createdAt: ISO 8601 날짜·시각 문자열 또는 null. 신규 등록은 DB가 실제 생성 시각을 저장합니다. migration 033 이전 행은 성공한 생성 감사의 가장 이른 occurred_at으로 복원하고, 이력이 없으면 null입니다. 이름·결제 설정·구성원을 바꿔도 등록일은 유지됩니다.
- 목록의 total_count는 기존대로 검색·필터 후 기업 또는 부서의 총 건수입니다. memberCount와 별개이며 페이지 밖 사원도 집계합니다.

프론트는 memberCount=12를 '사원 12명'으로, createdAt을 한국 시간의 MM.dd로 표시하면 됩니다. null은 등록일 미상으로 처리합니다. 생성·수정 요청으로 두 필드를 입력받지 않습니다.

기업·부서의 기존 필드는 유지하며, AI 고객 컨텍스트의 기업·부서 응답은 기존 DTO를 사용합니다. 부서는 기존 목록 조회로 상세 제목 줄의 값을 가져오며 별도 단건 조회 API는 추가하지 않습니다. 데이터 집계는 기존 인덱스를 사용하는 같은 SQL에서 수행하며 별도 저장 카운터나 Redis를 추가하지 않습니다.

배포 전에 033-organization-created-at.sql을 적용해야 합니다. 실제 서버 DB 적용과 배포는 이 코드 변경의 로컬 검증에 포함하지 않습니다.

디버 요청의 응답 제한은 10초입니다. 실패·시간 초과는 SUBMITTING_FAILED로 저장하고 최초 전송부터 10분 동안 마지막 시도에서 최소 1분 간격으로 자동 재전송합니다. 10분이 끝나면 SUBMISSION_FAILED로 전환하고 자동 재시도를 종료합니다. 첫/마지막 전송 시각은 046에서 추가한 별도 컬럼으로 유지하며 서버 재시작·주문 수정·재호출로 첫 기한을 연장하지 않습니다.

GET /api/admin/orders의 statusGroup=SUBMISSION_FAILED는 SUBMITTING_FAILED와 SUBMISSION_FAILED를 함께 조회하고 실제 status로 재시도 중/최종 실패를 구분합니다. PAID 그룹은 PAID·SUBMITTING·ACCEPTED만 포함합니다. 검색·기간·페이지 조건과 응답 형식은 유지하고 total_count도 같은 필터의 총 주문 수입니다. 기존 docs/api/admin-order-list.md의 PAID 그룹 설명보다 이 계약과 Swagger를 우선합니다.

자동 워커는 기동 시와 10초 주기로 미확정 전송·10분 기한을 확인합니다. 실제 재전송은 PAID와 기한 안의 SUBMITTING_FAILED 중 마지막 시도 후 1분이 지난 주문만 최대 20건 병렬 처리합니다. 최신 시도 시각으로 이전 응답을 차단하며 HTTP 대기 중 DB 트랜잭션을 유지하지 않습니다. 5년 보관 기한이 지난 주문은 이 배치에서 제외합니다. 기존 관리자 POST /api/admin/orders/{id}/retry는 최종 실패 후에도 수동 1회 요청으로 사용할 수 있으며 자동 기한을 새로 열지 않습니다. 결제·청구·수거 시각은 반복 처리하지 않습니다. 외부 디버의 멱등키·접수 조회 계약이 없어 응답 유실 후 재전송으로 생기는 외부 중복 접수는 보장하지 못합니다.

배포 DB 검증은 migration 033 적용 기록과 기업·부서의 `created_at` 타입·NULL 허용·현재 시각 기본값을 함께 확인합니다. Docker DB 회귀 테스트도 체크아웃한 `infra/database/verify.sql` 원문을 사용해 누락된 스키마를 거절하는지 검사하며, 이 SQL은 테스트 컨테이너에만 전달합니다.
