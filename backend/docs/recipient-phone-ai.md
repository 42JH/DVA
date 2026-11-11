# AI팀 전달 — 수령인 집전화 허용

같은 MR !560에 포함한 모놀리식 변경입니다. API URL·필드·토큰은 유지하며 **수령인과 발송인의 전화번호 검증을 분리**합니다. 백엔드 배포 시점에 맞춰 AI의 자체 검증도 맞춥니다.

| 필드 | 허용 값 |
| --- | --- |
| `parcel.origin.phoneNumber` / `parcels[].origin.phoneNumber` | `010`, `011`, `016`, `017`, `018`, `019`로 시작하는 휴대전화 **11자리** |
| `parcel.destination.phoneNumber` / `parcels[].destination.phoneNumber` | 위 휴대전화 + `02` 지역번호 **9~10자리** + 기타 아래 지역번호 **10~11자리** + `070` **11자리** |
| PIN의 `addressData.phoneNumber` | 수령인과 같은 전화번호 범위. 해당 PIN을 발송인으로 사용할 때는 다시 휴대전화 조건 적용 |

기타 지역번호: `031`, `032`, `033`, `041`, `042`, `043`, `044`, `051`, `052`, `053`, `054`, `055`, `061`, `062`, `063`, `064`.

모두 **하이픈·공백 없는 ASCII 숫자 문자열**로 보냅니다. 예: `01012345678`, `021234567`, `0212345678`, `0321234567`, `03212345678`, `07012345678`. 숫자 타입·국가번호·내선·구분자·줄바꿈은 받지 않습니다. 지역번호의 선행 0을 보존합니다. 접두사만 맞고 길이가 틀린 값도 거부합니다.

## 영향받는 기존 API

| API | 적용 필드/동작 |
| --- | --- |
| `POST /api/parcel-drafts` | `parcel.origin.phoneNumber`, `parcel.destination.phoneNumber` |
| `PATCH /api/parcel-drafts/{id}` | SAVE의 위 필드. START_EDIT·CANCEL·expectedVersion 규칙 유지 |
| `POST /api/orders` | 호환 경로의 `parcels[]` 출발·도착 전화번호 |
| `PATCH /api/orders/{id}` | `parcels[]` 출발·도착 전화번호 |
| `POST /api/customers/{id}/pins` | `addressData.phoneNumber` |
| `PATCH /api/pins/{id}` | `addressData.phoneNumber` |
| `POST /api/calls/{id}/order-intake/complete`, `POST /api/orders/{id}/submit` | 새 필드 없이 저장된 주문/초안에 동일 최종 검증 적용 |

수집 중 필드 생략·허용된 null·미완료 흐름은 유지합니다. READY 및 최종 접수에서는 발송인·수령인 연락처가 모두 필수입니다. 수기 접수의 수령인 PIN 자동 저장, AI의 기존 PIN 등록 API 호출, 디버 전송에서 집전화 문자열을 그대로 보존합니다. AI 완료 확정 API에 새 PIN 저장 기능을 추가하지 않습니다.

입력 형식 오류는 기존 400 `INVALID_REQUEST`입니다. 저장된 값의 최종 검증 실패는 422 `VALIDATION_FAILED`이며 `details[].field`는 `parcels.{index}.origin.phoneNumber` / `parcels.{index}.destination.phoneNumber`, reason은 각각 `mobilePhone` / `phoneNumber`입니다.

고객 계정·사원·발신자 식별 번호의 기존 11자리 계약, 주문 취소·결제 흐름, AI Bearer 및 `call_session_seq` 요구는 유지합니다. 기존 저장 데이터를 일괄 수정하지 않습니다. 이번 DELETE 통합에서 AI가 실제 호출하는 경로 변경은 확인되지 않아 AI DELETE 전환 작업은 없습니다. 새 AI 환경변수나 토큰도 없습니다.

프론트는 [통합 전달 명세](frontend-delete-admin-roles.md), 백엔드 전환은 [배포 안내](delete-roles-recipient-rollout.md)를 참고합니다. 실제 디버 운영 접수는 별도로 확인합니다.
