# 통화·녹취 조회 API

관련 작업: [S15P31D109-88](https://ssafy.atlassian.net/browse/S15P31D109-88).
관리자 화면의 통화 목록·상담 상세·발화·녹취 재생을 담당한다.
기존 AI 주문 수신과 PBX 녹취 수집 계약은 변경하지 않는다.

## 공통

- 경로: `/api`. OPERATOR·SUPERVISOR·SYSTEM_ADMIN의 활성 관리자 세션 쿠키 `dva_session`이 필요하다.
- AI 통화 헤더나 Bearer 값만으로 관리자 통화 기록을 조회할 수 없다.
- 목록: `{ data: [], hasNext }`. 단건: `{ data, meta: { requestId } }`.
- 모든 응답은 `Cache-Control: no-store`. 전화번호·대화 내용·녹취 URL을 요청 로그에 남기지 않는다.
- 경로 번호는 양의 int32다. 통화 경로의 `{id}`는 `call_sessions.call_session_seq`다.
- 기존 `call_sessions`, `call_utterances`, `handoff_requests`, `recordings`를 읽는다. 신규 테이블·마이그레이션은 없다.

## GET /api/calls — 통화 목록 조회

| 선택 query | 의미 |
| --- | --- |
| `orderSeq` | 연결된 주문 번호 정확히 일치 |
| `callerPhoneNumber` | 저장된 발신번호 정확히 일치. 숫자와 맨 앞의 `+` 허용 |
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
`call`은 목록과 같은 필드다. `recordings`는 아래 필드를 가진 배열이며 `recordingSeq` 오름차순이다.

| 필드 | 의미 |
| --- | --- |
| `recordingSeq`, `createdAt` | 녹취 번호와 DB 저장 시각 |
| `url` | 최대 5분 유효한 S3 재생 URL. 발급 실패 시 null |
| `expiresAt` | URL 만료 시각. 발급 실패 시 null |
| `playbackError` | 성공 시 null, 실패 시 NOT_FOUND 또는 DEPENDENCY_UNAVAILABLE |

해당 통화에 연결된 녹취만 읽고 S3 객체를 확인해 URL을 발급한다. `objectKey`는 별도 필드로 노출하지 않는다.
녹취 하나의 발급이 실패해도 통화 정보와 다른 녹취를 반환한다. 이 경우 HTTP 200이며 해당 항목에 오류를 표시한다.

통화 자체가 없으면 `404 NOT_FOUND`다. 통화는 있지만 녹취가 아직 없으면 `200`과 빈 배열을 반환한다.
상담원 기록이 없으면 `call.handoff`는 null이다. 배정 관리자·요약이 없는 연결 기록도 그대로 null을 유지한다.
연결 주문의 내용은 `GET /api/orders/{orderSeq}`로 조회한다.

## GET /api/calls/{id}/transcript — 통화 대화 내용 조회

`id`는 `call_session_seq`, 선택 query는 `limit`·`offset`이다.
응답은 `{ data: Utterance[], hasNext }`이며 `utteranceOrder` 오름차순이다.
발화 구간별 `callUtteranceSeq`, `utteranceOrder`, `speaker`(CUSTOMER/AI),
`utteranceText`, `lastSentenceSeq`, `receivedAt`을 반환한다.

누적 대화 원문은 줄바꿈을 포함해 그대로 제공한다. `receivedAt`은 최초 구간 수신 시각이며,
녹취의 재생 위치나 실제 발화 시작 시각을 뜻하지 않는다.
통화가 없으면 404, 저장된 발화가 없거나 마지막 페이지 이후이면 빈 목록이다.
빈 목록은 STT 기록이 없다는 뜻이며 통화가 무음이었거나 인식에 성공했다는 뜻이 아니다.

## 통화 상세의 녹취 재생 정보

`GET /api/calls/{id}` 한 번으로 통화 정보와 녹취 재생 URL을 받는다.
관리자 세션 확인 → 통화와 연결 녹취 조회 → 기존 S3 객체 존재 확인 → 임시 GET URL 서명 순서로 처리한다.
별도 `GET /api/recordings/{id}/url` API는 제거했다. 새 버킷·업로드 API·토큰 테이블은 만들지 않는다.

통화 상세 `data.recordings` 예시:

```json
[
  {
    "recordingSeq": 7,
    "createdAt": "2026-10-28T01:04:00.000Z",
    "url": "https://dva-d109-storage.s3.ap-northeast-2.amazonaws.com/recordings/example?X-Amz-Algorithm=AWS4-HMAC-SHA256&...",
    "expiresAt": "2026-10-28T01:09:00.000Z",
    "playbackError": null
  }
]
```

예시 URL은 실행용이 아니다. 실제 발급 URL을 프론트의 오디오 재생 주소로 사용한다.
최대 5분 유효하며, 임시 AWS 자격 증명이 먼저 만료되면 URL 만료도 그 시각에 맞춘다.
만료 후 통화 상세를 다시 조회해 새 URL을 받는다. S3 객체 삭제나 권한 철회가 있으면 만료 전에도 재생이 중단될 수 있다.
발급된 URL은 소지자가 만료 전까지 접근할 수 있으므로 공유·로그·장기 저장을 피한다.
발급 후 관리자 로그아웃만으로 기존 S3 URL이 즉시 폐기되지는 않는다.

기존 `AWS_REGION`, `S3_RECORDINGS_BUCKET`, AWS 자격 증명 설정을 그대로 사용한다.
IAM에는 해당 녹취 객체의 `s3:GetObject` 권한이 필요하다. 버킷은 비공개로 유지한다.
일반 오디오 태그로 URL을 재생할 수 있으며, 프론트에서 fetch·오디오 분석을 사용하면 버킷 CORS 설정이 별도로 필요할 수 있다.
설정 위치는 [기존 S3 연결 문서](recording-s3-setup.md)를 참고한다.
서명은 [AWS 공식 SDK](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-s3-request-presigner/)를 사용한다.

| `playbackError` | 조건 |
| --- | --- |
| null | URL 발급 성공 |
| `NOT_FOUND` | S3가 파일 미존재(404)를 확인 |
| `DEPENDENCY_UNAVAILABLE` | 버킷 미설정, S3 접근 거부·장애·타임아웃, 자격 증명·서명 실패 |

S3의 403은 파일 미존재로 단정하지 않는다. 실패 항목은 `url`·`expiresAt`이 null이며 DB 녹취 기록은 유지한다.
통화 자체가 없는 경우의 HTTP 404와 녹취 파일만 없는 경우의 `playbackError: NOT_FOUND`를 구분한다.
`objectKey`를 별도 응답 필드로 제공하지 않으며, 서명된 재생 URL에는 S3 객체 경로가 포함된다.

## 확인 방법

1. Swagger에서 기존 로그인 API로 로그인한다. 태그는 `Calls`다.
2. 통화 목록에서 `callSessionSeq`를 선택하고 상세의 연결 주문·녹취 목록·재생 URL을 확인한다.
3. 발화 조회에서 화자·문장·발화 순서를 확인한다. STT 미수집 통화는 빈 목록이다.
4. 상세의 `recordings[].url`로 오디오를 재생한다. 만료 후에는 상세를 다시 조회하고, URL이 null이면 `playbackError`를 확인한다.

자동 검증은 격리 PostgreSQL의 저장 데이터, 로컬 모의 S3와 실제 AWS SDK 서명,
관리자 세션 및 실제 Nginx 경유를 사용한다. 운영 AWS 버킷의 실제 녹취 재생은 별도 확인 대상이다.

## 수집 상태와 범위

- 현재 모놀리식은 AI 주문 결과로 통화 행을 만들고 PBX 웹훅 매칭 후 실제 시작·종료 시각을 저장한다.
  `endedAt: null`은 종료 정보가 아직 없다는 뜻이며 현재 통화 중이라고 단정할 수 없다.
- 주문 상태를 통화 종료 사유로 바꾸어 반환하지 않는다.
- STT·상담원 결과의 저장 경로는 현재 모놀리식에 없다. 조회 API가 해당 기록을 생성하거나 수집 완료를 보장하지 않는다.
- `customerSeq` 검색은 원본 API 명세대로 보류한다. 직접 고객-통화 관계가 없어 주문 없는 고객 통화를 완전하게 검색할 수 없다. 전달하면 400이다.
- 실제 상담원 연결 시각은 현 스키마에 없으므로 제공하지 않는다. 수집 계약·저장 구조 확정이 별도로 필요하다.
- 실시간 통화 추적, 상담원 연결 제어, STT 생성, 별도 상담원 이력 API, 관리 메모·콜백은 이번 조회 범위에 포함하지 않는다.
