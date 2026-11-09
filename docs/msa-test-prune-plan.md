# MSA 테스트 정리 계획

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
MR: [!395](https://lab.ssafy.com/s15-final/S15P31D109/-/merge_requests/395)
정리 전 소스: `d8d27da381048f00b95733482ce39b1132770d1f`.
수정은 msa/docs로 한정하고 업무 src·API·changelog·frontend·AI는 수정하지 않는다.

## 제거와 대체 근거

| 제거 대상 | 남기는 검증 |
|---|---|
| 불변 055 원본 checks 이미지의 단위/결제 데모 재검사 | 원본 SHA/tree 보호, 실제 원본 production 이미지 빌드, 원본과 MSA의 HTTP/DB 비교 |
| 모놀리식에서만 다시 실행하는 auth/persona/FAQ/PBX/상담/주문 조회·취소·삭제·청구 회귀 | 동일 입력을 원본과 MSA에 보내는 기존 production 동등성 회귀, MSA의 직접 통합 검사 |
| operations environment 파일의 런타임 중복 실행 | 동일 이미지 builder의 같은 환경 검사 |
| 5개 service health 반환값 단위 파일 | 서비스별 실제 HTTP health 응답 및 readiness 실패 검사 |
| 이벤트 단계의 parcel-drafts 단위 3개·계약 6개 중복 | 이벤트 이미지의 단위 검사, Jenkins의 항상 실행하는 계약 검사 |
| Jenkins에서 더 이상 호출하지 않는 has-msa-changes.sh와 12개 회귀 | 현재 plan-apps.py의 실제 Git 선택·배포 이력·단계별 검증 이력 회귀. 유효한 분기 이력 보호 1건은 현행 선택기로 이관 |
| 001~054 이전 버전별 migration 변환·실패 주입 재현 및 구형 order/delivery workflow SQL | 5개 현행 스키마 신규 설치/업무 SQL/재적용, 원본 schema/function 비교, 공통 원자성/변경 fingerprint, 실제 055 전환의 데이터·이력·rollback 검사 |
| 주문 원본 회귀 제거 후 사용하지 않는 orders/manual-orders helper patch | 실제 사용하는 application helper patch와 정확한 원본 변경 범위 보호 |

055 이전 특정 버전의 데이터 변환 재현은 자동 회귀 범위에서 제외한다. 현행 055 전환·불변 migration checksum·배포 시 fingerprint/백업/복구는 유지한다. 최초 052 수동 동등성 진단은 이번 CI 정리와 분리해 유지한다.

## 집계와 검증

테스트 개수는 test() 선언 줄 수가 아닌 Node/Jest/unittest 결과의 실제 사례 수를 사용한다.
전체 CI 계획은 중복 실행을 포함하고 BuildKit 캐시 여부와 구분한다.
기존 성공 로그의 입력이 정리 전 소스와 동일한지도 Git으로 확인한다.
DB 보고서의 checks는 준비·명령·정리를 포함하므로 테스트 개수에 합치지 않는다.

정리 후 현재 회귀 전체, 실제 PostgreSQL의 현행 스키마/055 이행, 실제 production 원본과 MSA 비교를 다시 실행한다.
사용이 끝난 파일 참조·기본 npm test·이미지 선택·원본 보호도 검증하고 전후 개수·제외 범위를 결과 문서와 MR에 반영한다.
