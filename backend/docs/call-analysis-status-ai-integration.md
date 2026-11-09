# AI 통화 분석 최종 실패 통보 — 056

모놀리식 backend 계약이다. AI 소스는 이번 작업에서 수정하지 않았다. [배포 순서](call-analysis-status-rollout.md)를 따른다.

## 인증과 기존 성공 경로

기존과 신규 분석 API 모두 `Authorization: Bearer <AI_INSIGHTS_TOKEN>`을 사용한다. 주문·고객용 AI_BUSINESS_TOKEN과 다르며 관리자 쿠키로 대체할 수 없다. 새 환경변수는 없다.

기존 `POST /api/ai/calls/{callSessionSeq}/analysis` 요청·204 응답과 동일 본문 재전송/다른 본문 409 계약을 유지한다. 정상 분석을 저장하면 조회 상태는 COMPLETED다.

## 최종 실패 통보

```http
POST /api/ai/calls/123/analysis/failure
Authorization: Bearer <AI_INSIGHTS_TOKEN>
Content-Type: application/json
```

```json
{
  "providerCallId": "rtc_example"
}
```

경로는 DB callSessionSeq, 본문은 그 통화의 OpenAI providerCallId다. providerCallId는 기존 정상 분석과 동일한 1~200자 비공백/NUL 없는 문자열이다. call_session_seq 헤더·실패 시각·원문 오류·카운터·실패 사유 필드는 보내지 않는다. 알 수 없는 필드는 400이다.

유효한 최초 실패와 동일 요청 재전송은 본문 없는 204다. 서버가 최초 수신 시각만 기록하며 재전송으로 갱신하지 않는다. 정상 분석이 이미 저장된 통화도 204이며 완료 상태를 유지한다.

| HTTP | 의미 |
| --- | --- |
| 204 | 최초 기록 또는 중복/완료 우선 처리 성공 |
| 400 | 경로·본문 형식 오류/미허용 필드 |
| 401 | insights 토큰 누락·오류 |
| 403 | 통화 번호와 providerCallId 불일치(또는 기존 Origin 보안 검사) |
| 404 | 없는 통화 또는 기존 정책상 삭제·보관 만료 |
| 503 | 서버 insights 인증 미설정 |
| 500 | 내부 저장 실패. 실패 기록·성공 감사 함께 롤백 |

오류 응답은 기존 `{error,meta}` 형식이다. 통화가 없다고 이 API가 통화를 새로 생성하지 않는다. PBX 웹훅 수신 순서와 관계없이 저장할 수 있고 PBX 종료·주문·녹취·기존 분석을 변경하지 않는다.

## 어떤 실패를 보낼지

- 분석 단계의 최종 실패만 보낸다. 일시 연결 장애/처리 중으로 분석을 계속 재시도하는 동안은 보내지 않는다.
- 현재 outbox 전체 FAILED에는 FAQ·미답변·대시보드 실패도 포함된다. 전체 상태를 그대로 분석 실패로 통보하지 않는다. 정상 분석 POST가 성공한 경우 다른 단계 실패는 해당 통화의 분석 상태를 FAILED로 바꾸지 않는다.
- 실패 통보도 AI의 영속 전송/재전송 관리에 포함한다. 타임아웃은 서버 미저장을 뜻하지 않으므로 같은 통화·본문으로 재전송한다. 백엔드가 중복 기록을 막는다.
- 400/401/403/404는 본문·인증·식별자/수명 문제를 확인한다. 5xx·타임아웃은 재전송 대상으로 관리한다. 인증 오류나 경로 오류를 정상 전송으로 처리하지 않는다.
- 분석 복구 후 정상 결과를 기존 성공 API로 보내면 COMPLETED가 우선한다. 정상 분석을 가짜 0건·빈 값으로 만들어 실패를 표현하지 않는다.

2026-11-09부터 정상 분석·실패 통보가 없는 통화는 PBX 종료 후 10분 이상이면 EXPIRED, 종료 미수집 또는 10분 미만이면 PENDING이다. 시간 경과만으로 FAILED나 COMPLETED를 만들지 않는다. 분석 성공·실패 POST 계약은 그대로이며 AI의 실제 정상 결과가 늦게 저장되면 COMPLETED가 우선한다.

## 조회와 과거 통화

관리자 목록 data[]·상세 data.call·홈 data.recentCalls[]에 analysisStatus·recordedAt을 반환한다. 정상 분석 있음 → COMPLETED, 없고 실패 수신 기록 있음 → FAILED, 둘 다 없고 PBX 종료 후 10분 경과 → EXPIRED, 그 외 → PENDING이다. 녹취·주문 확정 완료는 분석 완료를 뜻하지 않는다.

기존 분석은 자동으로 COMPLETED로 조회된다. 분석 없는 과거 통화는 일괄 FAILED로 바꾸지 않는다. AI가 실제 분석 단계 실패를 확인한 보관 기간 내 기존 통화만 새 API로 통보한다. 실패 시각은 재전송을 받은 현재 서버 시각이며 통화의 최초 보관 기한은 연장되지 않는다.

실패 증거는 call_sessions에 남아 기존 통화의 soft delete·5년 보관을 따른다. 7일 로그 정리로 지워지는 상태가 아니다. MSA의 별도 consultation DB/API는 후속 동기화 대상이며 056으로 변경되지 않는다.
