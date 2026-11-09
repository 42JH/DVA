# 프론트 통화 분석 상태·첫 녹취 저장 시각 — 056

모놀리식 backend 계약이다. 프론트 소스는 이번 작업에서 수정하지 않았다. [배포 순서](call-analysis-status-rollout.md)와 [AI 실패 통보](call-analysis-status-ai-integration.md)를 함께 확인한다.

기존 관리자 세션·권한·Origin·페이지네이션·검색과 응답 구조를 유지하며 아래 두 필드만 추가한다.

| API | 필드 위치 |
| --- | --- |
| GET /api/calls | data[].analysisStatus, data[].recordedAt |
| GET /api/calls/{id} | data.call.analysisStatus, data.call.recordedAt |
| GET /api/dashboard/home | data.recentCalls[].analysisStatus, data.recentCalls[].recordedAt |

```json
{
  "analysisStatus": "FAILED",
  "recordedAt": "2026-11-08T06:00:00.000Z"
}
```

위 예시는 추가 필드만 발췌한 것이다. 기존 analysis·recordings·통화·주문 필드는 유지한다.

## 표시 기준

| analysisStatus | 의미 | 표시 예시 |
| --- | --- | --- |
| PENDING | 정상 분석·확정 실패 통보가 없고 PBX 종료 미수집 또는 종료 후 10분 미만 | 분석 대기 |
| COMPLETED | 정상 분석이 백엔드에 저장됨. 과거 실패 통보보다 우선 | 분석 완료 |
| FAILED | 정상 분석 없이 AI의 최종 분석 실패 통보를 수신 | 분석 실패 |
| EXPIRED | 정상 분석·확정 실패 통보 없이 PBX 종료 후 10분 이상 경과 | 분석 만료 |

실패 후 정상 분석이 도착하면 COMPLETED다. 정상 분석 후 늦은 실패 통보는 완료 상태를 유지한다. analysis가 null일 때 가짜 0건 분석을 만들지 않는다.

2026-11-09 사용자 확정으로 서버가 종료 후 10분을 기준으로 EXPIRED를 반환한다. 별도 타이머나 DB 상태 갱신 없이 조회 시 계산하며 종료 시각이 없으면 수신 후 오래 지났어도 만료시키지 않는다. EXPIRED일 때 analysis는 null이고 실패 통보·감사 기록을 만들지 않는다. 시간만으로 COMPLETED가 되는 경로는 없다. 실제 정상 결과가 늦게 저장된 경우에만 COMPLETED로 조회한다.

클라이언트가 통화 종료 후 5분 경과나 녹취 존재 여부로 실패를 추정하는 우회를 제거한다. 목록 표시를 위해 통화마다 상세 API나 POST customers/context를 추가 호출하지 않는다. 이번 작업에 상태 필터·분석 재실행 API·SSE는 추가하지 않았다.

클라이언트의 상태 타입과 표시 함수는 EXPIRED를 지원해야 한다. 2026-11-09 최신 develop-fe `f23693d0`의 `features/call/callState.ts`에는 이미 `EXPIRED → 분석 만료` 분기가 있고 해당 상태 테스트도 확인했다. 이전 v2 경로 안내는 현재 구조와 다르다. 이 확인은 원격 소스의 정적 대조이며 프론트 소스 수정·테스트 실행·실제 화면 확인은 이번 backend 작업에 포함하지 않았다.

## recordedAt 의미

- 기존 recordings.created_at 중 가장 이른 값이다. 녹취 참조가 DB에 저장된 시각이며 실제 녹음/통화 시작 시각이 아니다.
- ISO 8601 시각 문자열 또는 null이다. 기존 시각처럼 사용자 시간대로 표시한다.
- 녹취가 없으면 null이다. 파일 재생 가능 여부·분석 완료·실패는 이 값으로 판단하지 않는다. 재생은 기존 recordings의 URL/오류 계약을 따른다.
- 녹취가 여러 개여도 목록에는 통화당 한 행이고 total_count·limit/offset은 유지한다.

## 기존 데이터와 적용

정상 분석이 있는 기존 통화는 COMPLETED다. 분석도 실패 수신 기록도 없는 기존 통화는 PBX 종료 후 10분이 지났으면 EXPIRED, 그 외 PENDING이다. 기존 306번도 이 조건으로 조회된다. AI가 실제 실패를 확인해 통보해야 FAILED가 된다. 기존 데이터 backfill·일괄 UPDATE는 필요 없다.

통화의 기존 soft delete·5년 만료 필터를 유지한다. 삭제·만료 통화가 상태 필드 추가로 다시 보이지 않는다. 실제 분석 내용과 불만/주문/FAQ 건수·기존 녹취 배열은 유지한다.

백엔드 배포와 타입·응답 스키마·화면 매핑 갱신을 조율한다. 056 이후 10분 만료 자체에 추가 migration·환경변수는 없다. MSA 별도 공개 API로 전환할 때는 같은 계약이 이식됐는지 확인한다.
