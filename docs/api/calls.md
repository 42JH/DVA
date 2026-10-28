# 통화·녹취 조회 API

관련 작업: [S15P31D109-88](https://ssafy.atlassian.net/browse/S15P31D109-88).
관리자 화면의 통화 목록·상담 상세·발화·녹취 재생을 담당한다.
기존 AI 주문 수신과 PBX 녹취 수집 계약은 변경하지 않는다.

## 공통

- 경로: `/api`. OPERATOR·SUPERVISOR·SYSTEM_ADMIN의 활성 관리자 세션 쿠키 `dva_session`이 필요하다.
- AI 통화 헤더나 Bearer 값만으로 관리자 통화 기록을 조회할 수 없다.
- 목록: `{ data: [], hasNext }`. 단건: `{ data, meta: { requestId } }`.
- 모든 응답은 `Cache-Control: no-store`. 전화번호·대화 내용·녹취 URL을 요청 로그에 남기지 않는다.
- 경로 번호는 양의 int32다. 통화 경로의 `{id}`는 `call_sessions.call_session_seq`, 녹취 경로의 `{id}`는 `recordings.recording_seq`다.
- 기존 `call_sessions`, `call_utterances`, `handoff_requests`, `recordings`를 읽는다. 신규 테이블·마이그레이션은 없다.

## GET /api/calls — 통화 목록 조회

| 선택 query | 의미 |
| --- | --- |
| `orderSeq` | 연결된 주문 번호 정확히 일치 |
| `callerPhoneNumber` | 숫자로만 된 발신번호 정확히 일치 |
| `from`, `to` | 실제 `started_at` 기준. from 포함·to 미포함, 시간대 필수 |
| `endReason` | 저장된 종료 사유 정확히 일치. 종료 사유 코드 목록은 미확정 |
| `handoffStatus` | REQUESTED / CONNECTED / FAILED |
| `limit`, `offset` | 기본 20·0, limit 1~100 |

조건은 모두 AND로 결합한다. `startedAt DESC NULLS LAST, callSessionSeq DESC`로 정렬한다.
시작 시각이 없는 통화는 기간 검색에서 제외되고, 기간 조건 없는 목록에서는 마지막에 표시한다.

응답 항목:

| 필드 | 의미 |
| --- | --- |
| `callSessionSeq`, `providerCallId` | 내부 통화 번호와 OpenAI 통화 식별자 |
| `callerPhoneNumber` | 발신번호, 미확인 시 null |
| `orderSeq` | 연결 주문 번호, 없으면 null. 주문 내용은 기존 주문 상세 API에서 조회 |
| `startedAt`, `endedAt` | 실제 통화 시각. 미수집 시 null |
| `endReason` | 저장된 종료 사유. 미확인 시 null |
| `handoff` | 연결 기록이 없으면 null. 있으면 아래 연결 정보 |

`handoff`는 `handoffRequestSeq`, `reason`, `status`, `assignedAdminUserSeq`, `summaryText`,
`requestedAt`을 반환한다. REQUESTED는 요청 기록이며 연결 성공이 아니다.
CONNECTED·FAILED도 실제 저장된 값을 조회한다. 요청 시각을 연결 완료 시각으로 대신하지 않는다.

빈 목록은 `200 { "data": [], "hasNext": false }`다.
잘못된 날짜·역전된 기간·중복 query·지원하지 않는 필드는 `400 INVALID_REQUEST`다.

## GET /api/calls/{id} — 통화 상세 조회

`id`는 `call_session_seq`다. 응답의 `data`는 `{ call, recordings }`다.
`call`은 목록과 같은 필드이며, `recordings`는 `{ recordingSeq, createdAt }` 배열이다.
녹취는 `recordingSeq` 오름차순으로 반환한다. 다른 통화의 녹취와 S3 `objectKey`는 포함하지 않는다.
상세 조회는 S3에 접속하지 않고 저장된 메타데이터를 반환한다.

통화 자체가 없으면 `404 NOT_FOUND`다. 통화는 있지만 녹취가 아직 없으면 `200`과 빈 배열을 반환한다.
상담원 기록이 없으면 `call.handoff`는 null이다. 배정 관리자·요약이 없는 연결 기록도 그대로 null을 유지한다.
연결 주문의 내용은 `GET /api/orders/{orderSeq}`로 조회한다.

## 수집 상태와 범위

- 현재 모놀리식은 AI 주문 결과로 통화 행을 만들고 PBX 웹훅 매칭 후 실제 시작·종료 시각을 저장한다.
  `endedAt: null`은 종료 정보가 아직 없다는 뜻이며 현재 통화 중이라고 단정할 수 없다.
- 주문 상태를 통화 종료 사유로 바꾸어 반환하지 않는다.
- STT·상담원 결과의 저장 경로는 현재 모놀리식에 없다. 조회 API가 해당 기록을 생성하거나 수집 완료를 보장하지 않는다.
- `customerSeq` 검색은 원본 API 명세대로 보류한다. 직접 고객-통화 관계가 없어 주문 없는 고객 통화를 완전하게 검색할 수 없다. 전달하면 400이다.
- 실제 상담원 연결 시각은 현 스키마에 없으므로 제공하지 않는다. 수집 계약·저장 구조 확정이 별도로 필요하다.
- 실시간 통화 추적, 상담원 연결 제어, STT 생성, 별도 상담원 이력 API, 관리 메모·콜백은 이번 조회 범위에 포함하지 않는다.
