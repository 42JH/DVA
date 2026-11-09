# MSA 테스트 정리 결과

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
MR: [!395](https://lab.ssafy.com/s15-final/S15P31D109/-/merge_requests/395)
[계획과 제거/유지 근거](msa-test-prune-plan.md)

정리 전 소스는 `d8d27da3`, 전체 통합 검증 소스는 `1887ff55`다.
분기 이력 보호 1건을 이관한 최종 테스트 소스 `b54f9e6f`에서도 124개 배포 회귀를 새로 실행했다.
두 정리 후 소스의 서비스·DB·이벤트·업무 실행기·Jenkins 입력은 Git diff로 동일함을 확인했다.
수정 범위는 msa/docs이며 업무 API·SQL changelog·실제 backend/frontend/AI checkout은 수정하지 않았다.

## 실제 테스트 개수

전체 CI 선택 계획의 중복 실행을 포함한 사례 수다. Node/Jest/unittest가 보고한 실제 개수를 사용했다.
BuildKit 캐시가 적중하면 이번 콘솔에 결과가 다시 출력되지 않으므로 캐시 여부와 별개인 전체 계획으로 비교한다.
추가 검증용 재실행이나 수동 052 진단은 이 합계에 넣지 않았다.

| 구분 | 정리 전 | 정리 후 | 감소 |
|---|---:|---:|---:|
| 배포·범위 선택·원본 보호 Python | 135 | 124 | 11 |
| 항상 실행하는 계약/fixture 단위 | 10 | 10 | 0 |
| 서비스 Jest/HTTP e2e | 43 | 38 | 5 |
| 서비스 Node 단위 | 94 | 94 | 0 |
| 변경되지 않는 원본의 compiled/결제 데모 재검사 | 215 | 0 | 215 |
| 이벤트 단위/통합 | 34 | 25 | 9 |
| 네 업무 회귀 | 629 | 293 | 336 |
| **합계** | **1,160** | **584** | **576 (49.7%)** |

| 업무 회귀 | 정리 전 | 정리 후 |
|---|---:|---:|
| operations | 330 | 163 |
| customer | 8 | 8 |
| consultation | 177 | 50 |
| order | 114 | 72 |

이벤트의 기존 실행은 이미지 단위 10 + 중복 parcel-drafts 3 + 통합 15 + 중복 계약 6 = 34개다.
이미지 단위 10개에 parcel-drafts 3개가 이미 포함된다. 초기 집계에서 이 3개를 한 번 더 더한 1,163은
원본 로그 대조 후 1,160으로 정정했다. 정리 후에는 이미지 단위 10 + 통합 15 = 25개다.

## 삭제한 것

- 불변 055 원본 checks 이미지와 여기서 매번 돌리던 backend 194개·결제 데모 21개를 제거했다.
  원본은 production 이미지를 빌드해 실제 HTTP·DB 동등성 비교에 계속 사용한다.
  네 실행기의 빈 원본 DB 준비는 고정 migration을 적용하는 공통 test-only 준비 파일로 대체했다.
- 원본에서만 따로 실행하던 auth·limits·persona·FAQ·PBX·상담·고객/PIN·주문 조회/삭제/취소/청구 회귀를 제거했다.
  같은 입력을 원본과 MSA에 보내 응답·DB·감사·이벤트를 비교하는 기존 회귀와 MSA 직접 검사는 유지했다.
- operations environment 파일의 재실행 6개, 이벤트 parcel-drafts 3개·계약 6개 재실행을 제거했다.
- 5개 health 반환값 단위 파일을 삭제했다. 실제 HTTP의 같은 body·readiness 실패 검사는 남겼다.
  사용이 끝난 Jest 단위 설정/명령을 정리하고 기본 npm test가 남긴 e2e를 실행하도록 연결했다.
- 호출자가 없는 has-msa-changes.sh와 구형 회귀 12개를 삭제했다.
  유효한 분기 이력 보호 1건은 현행 검증 선택기로 이관해 Python은 순수하게 11개 줄었다.
- 001~054 이전 버전별 변환/실패 주입 재현과 구형 좌표 필드가 있는 order/delivery workflow SQL 2개를 제거했다.
  현재 5개 전체 스키마·업무 SQL·재적용·공통 원자성·pending/stale fingerprint·원본 schema/function 비교와
  실제 055 이행의 snapshot·데이터·이력·rollback 검증은 남겼다.
  order-audit 제약 검사는 현행 operations 스키마 검사로 옮겨 유지했다.
- 원본 주문 회귀 제거 후 사용하지 않는 orders/manual-orders helper patch를 삭제했다.
  남은 application helper만 허용하며 API·다른 테스트/기대값을 바꾸는 patch는 계속 거부한다.

삭제한 검사를 skip이나 다른 자동 실행 명령으로 옮기지 않았다. 현행 MSA 검사 94개와 e2e 38개,
역할/소유권·금액·중복 방지·감사 실패·실제 SIGKILL/응답 유실 복구 검사는 통과했다.

## DB 단계와 이미지

DB 보고서의 checks는 준비·명령·정리도 포함하므로 위 테스트 개수와 합산하지 않는다.

| 항목 | 이전 | 정리 후 |
|---|---:|---:|
| 실제 DB 실행·검증 단계 | 621 | 176 |
| 전체 CI 이미지 | 13 | 11 |
| 동일 입력 배포 재시도 이미지 | 6 | 6 |

delivery의 유효한 Node 단위 2개는 builder에서 한 번 실행해 별도 checks 이미지가 필요 없다.
자동 CI는 monolith-checks/delivery-checks를 선택하지 않으며 잘못 요청한 target도 거부한다.
수동 052 진단도 사용하지 않는 MSA checks 이미지의 빌드를 제거했으며 원본 checks는 그 진단에서만 유지한다.

## 실행 근거

- Linux/Docker의 11개 이미지 빌드 성공. Jest e2e 38개·서비스 Node 94개 전부 통과.
- 배포/선택/원본 보호 124개, 고정 계약/fixture 단위 10개 통과. 분기 보호 이관의 16개 선택 회귀도 통과.
- DB 176단계와 네 업무 회귀 293개 통과. 별도 PostgreSQL dump/restore 전환 fixture도 통과.
- 동일 입력의 새 checkout/release 재시도에서 DB·업무·이벤트·배포 회귀 미선택,
  빠른 계약 10개 유지, 이미지 6개와 DB/앱 패키지 생성 성공을 확인했다.
- 실제 DB 1개·앱 5개 패키지의 SHA-256 및 manifest 이미지 ID 일치도 확인했다.
- 원본 준비가 production/비테스트 DB 환경을 거부하는 것과 실제 임시 DB의 새 준비 경로를 확인했다.
- 고정 원본은 계속 `9624b778`, 원래 backend tree는 `12c6fa0f17354f53b28244d8b804bd564f1141be`다.
  application helper만 적용한 임시 tree는 `be9f6bf6b71b20831b538b99fa00645efddba589`다.

이전 집계는 입력이 같은 기존 성공 로그를 사용했다. 서비스 이미지/이벤트 입력은 `0a3d6623`과 `d8d27da3`의
Git diff로 동일함을 확인했고, 원본 helper 정규화 전후 tree도 동일했다. 업무/배포 회귀는 전체 성공한 `4b360b07` 로그를 사용했다.
정리 후 결과는 새 전체 실행과 최종 소스의 실제 124개 결과로 집계했다.

근거는 Git 제외 경로 `msa/liquibase/verification-logs/test-prune/`에 보존한다.
`before-counts.json`, `case-counts.json`, `run-1/integration-report.json`, `run-1/full-raw/`,
`final/verification.json`, `final/unit.log`에 개수·원본 출처·전체 성공·개별 로그가 있다.
원래 성공 로그는 `msa/liquibase/verification-logs/deploy-stdin/`에 보존한다.

## 시간과 제외 범위

동일 로컬 Docker에서 DB 구간은 이전 264.067초, 정리 후 134.890초였다.
전체 실행의 캐시/설치/부하 조건은 통제한 A/B 실험이 아니며 공식 Jenkins 총시간 감소율로 환산하지 않는다.
남은 검사에는 실제 worker 재시도/종료/복구 대기와 이미지 준비가 포함된다.

055 이전 특정 버전의 데이터 변환 재현은 자동 회귀 범위에서 제외했다. 현재 055 전환과
배포 시 checksum/fingerprint·quiescence·백업·복구는 유지한다. 공식 Jenkins Job과 운영 배포는 실행하지 않았다.
기존 최초 052 동등성 진단과 업무 API 23개 미구현은 별도 결과로 유지하며 이번 정리는 전체 업무 동등성 완료 판정이 아니다.
