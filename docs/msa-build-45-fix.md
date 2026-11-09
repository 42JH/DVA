# Jenkins MSA #45/#46 주문 검증 실패 분석과 수정

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
이전 수정: [!416](https://lab.ssafy.com/s15-final/S15P31D109/-/merge_requests/416)

## 실제 로그에서 확인한 범위

#45는 !416 병합 커밋 `fc80e3998c6f75cc5ca22061324f84723ee780ba`로 실행됐다.
#44의 env 샌드박스 오류는 발생하지 않았고 deployment/events/database/operations/customer/consultation의 성공 이력이 기록됐다.
주문 조회 비교의 `more simultaneous AI reads than any owner pool finish without a callback deadlock`에서
원본 `GET /api/orders/1001`이 200 대신 500을 반환해 실패했다. 하위 사례 하나와 상위 test가 함께 실패했다.
MSA 쪽에도 같은 구간의 내부 조회 503과 긴 지연이 관측됐다. DB 검증은 이미 통과했으며 실제 DB/앱 배포 전 중단됐다.

원본 로그는 INTERNAL_ERROR의 상세 예외를 노출하지 않는다. 따라서 당시의 정확한 pg 예외가
연결 획득 timeout인지 SQL timeout인지는 보관 로그만으로 확정하지 않는다. 커널 OOM 기록도 없었다.
같은 1 CPU·2GB 한도의 새 엔진에서는 기존 코드가 통과해 상시 발생하는 데이터/DTO 오류로 단정하지 않았다.

분석 중 종료된 #46(`8c461a2c`)도 원문과 보관된 앱 로그를 추가 확인했다.
DB/events/operations/customer/consultation은 기존 성공 이력으로 생략됐고 주문 앱 시작 확인에서 실패했다.
주문 앱에는 `backend_startup_failed`가 있으나 예외 상세가 없고 당시 DB 로그/자원 snapshot도 보관되지 않았다.
#45의 원본 HTTP 500과 같은 예외라고 단정하지 않는다. 두 실행 구간의 커널 기록에는 OOM 근거가 없었다.

주문은 시작할 때 consultation에 기존 초안 연결 복원/정리 요청을 보낸다.
검증 실행기는 consultation 컨테이너를 시작한 직후 준비 확인 없이 주문을 시작하고 있었다.
상담 앱의 listen만 5초 지연하자 주문의 시작 종료와 `app did not start: order`를 재현했다.
이를 막도록 기존 055 검사와 같은 health 확인을 main consultation 시작에도 적용한 뒤 주문을 시작한다.
업무 앱의 실패 정책이나 요청 timeout은 바꾸지 않는다. 이 제어 재현도 #46의 보관되지 않은 상세 예외와 구분한다.

## 실패 경로와 수정

기존 동시성 사례는 12개의 비교 각각에서 먼저 원본을 조회한 뒤 MSA를 조회했다.
원본의 동시 부하와 MSA callback 검사가 겹쳤고, 원본의 응답 순서에 따라 MSA 동시성도 달라졌다.
원본과 MSA의 DB pool은 각각 최대 5개, 연결 획득 제한은 2초다.

격리 엔진에서 원본 pool에 대기열이 있을 때만 이미 획득한 연결의 전달을 2.2초 지연시켰다.
수정 전 같은 경로의 원본 500을 재현했고 `timeout exceeded when trying to connect`, total=5/idle=0을 기록했다.
이는 **원본 pool 경합에 대한 제어 재현**이며 실제 #45의 숨겨진 예외를 직접 확보한 결과와 구분한다.

원본의 동일 입력 결과는 먼저 한 번 얻고 MSA에 실제 동시 12건을 보내도록 변경했다.
12개 모두 원본과 HTTP 200·본문·request ID·no-store를 엄격히 비교한다. 업무/감사/이벤트 불변성 검사도 그대로다.
pool 크기와 앱/SQL/HTTP timeout, 기대 상태, 테스트 개수는 변경하지 않았다.

055 이관 검사가 완료된 order/consultation 임시 앱 두 개도 다음 단계 전에 중지한다.
기존에는 같은 DB 안의 별도 시험 DB를 사용하는 두 프로세스가 전체 주문 검사 종료까지 남아 있었다.
정리는 호출자인 `verify-order.py`에 두어 공통 선택 정책을 바꾸지 않고 주문 검사만 다시 선택하도록 했다.
실패 시에는 앱뿐 아니라 임시 DB 로그와 자원 snapshot도 보관한다.
Jenkins의 모든 실패를 DB 실패처럼 안내하던 공통 문구는 최초 실패 단계의 로그를 보도록 고쳤다.

## 중단된 #43의 잔존 자원

실제 CI 엔진에는 `dva-operations-check-a11799235db7`의 PostgreSQL 세 개와 persona peer가 남아 있었다.
생성 시각은 2026-11-09 01:31~01:32 UTC이며 #43의 ABORTED 상태, test-run/ci-run 라벨을 확인했다.
DB는 영구 볼륨/호스트 bind가 없는 tmpfs 전용이었다. 네 개의 정확한 이름·ID·소유권을 검증한 뒤 중지했다.
현재 빌드의 컨테이너와 운영 앱/DB는 대상으로 삼지 않았다. 전역 prune이나 자동 과거 자원 삭제는 추가하지 않았다.
이 잔존 자원이 #45 실패의 유일한 원인이었다고 단정하지 않는다.

## 검증 입력과 판정 기준

- 실제 서버와 같은 Docker DinD 이미지 digest `sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977`.
- 엔진 1 CPU·메모리 2GiB·memory+swap 4GiB, 실행기 0.5 CPU·1GiB, 외부 포트 없는 내부 네트워크.
- 실제 CI의 Node 24.22.2 digest `sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`를
  임시 검증 Dockerfile에 고정했다. 저장소의 Dockerfile은 수정하지 않았다.
  최초 로컬 Node 24.22.1 결과는 보조 자료이며 최종 판정은 24.22.2에서 다시 실행한 결과를 사용한다.
- 055 원본 커밋 `9624b778`의 backend tree는 `12c6fa0f17354f53b28244d8b804bd564f1141be`다.
  기존 승인된 `reference-tests.patch`를 적용한 검증 전용 backend tree는 `be9f6bf6b71b20831b538b99fa00645efddba589`다.
- 수정 전 `fc80e399`와 develop-backend `8c461a2c`를 병합하고 시작 순서 보완을 포함한 `a826c354`로 이미지를 준비했다.
  8개 이미지의 실행 layer/Config는 소유권 라벨 `dva.ci-run`을 제외하고 동일함을 대조했다.
  바깥/격리 엔진 사이의 모든 layer와 Config도 일치하며 엔진별 image ID는 실제 로드한 ID를 기록했다.
- 원본의 제어 지연은 테스트 컨테이너의 NODE_OPTIONS 준비 파일에서만 적용했다.
  pg의 Promise 반환/예외를 보존하며 pool 대기열이 생겼을 때만 연결 전달을 지연한다.
  실제 backend checkout과 컴파일 결과, 업무 요청/기대값은 수정하지 않았다.
- 상담 시작 지연 재현도 임시 NODE_OPTIONS 파일에서만 listen을 5초 늦췄다.
  두 제어 조건을 함께 둔 검사는 수정 드라이버를 읽어 실행하며, 최종 일반 회귀는 커밋된 소스에서 실행한다.
- 최종 전체 주문 회귀는 지연 주입 없이 실행한다. 조회뿐 아니라 삭제·취소·실제 SIGKILL/ACK 유실,
  055 이행·초안 보관·청구 월 전환·실제 워커 타이머와 의존 장애를 포함한다.

## 검증 결과

| 검사 | 결과 | 실행기 시간 |
|---|---|---:|
| 원본 pool 경합, 수정 전 | 같은 조회 500 재현, 13개 중 하위 1개와 부모 실패 | 87.618초 |
| 같은 pool 경합, 조회 수정 후 | 13개 통과, 원본 1건 뒤 MSA 동시 12건 모두 200 | 58.641초 |
| 상담 listen 5초 지연, 시작 순서 보완 전 | 주문 시작 종료와 `app did not start: order` 재현 | 80.023초 |
| 상담 시작 지연 + 원본 pool 경합, 준비 확인 후 | 13개 통과, 동일 응답·DB·감사·이벤트 검사 유지 | 68.210초 |
| 최종 `a826c354`, 일반 주문 회귀 | 72개 통과, 실패/취소/생략 0개 | 93.155초 |
| Linux Python 배포·선택·원본 보호 | 124개 통과 | 94.212초 |
| 고정 원본 목록·계약·fixture 보호 | 10개 통과 | 0.283초 |

시간은 로컬 격리 실행기의 준비/정리를 포함하며 이미지 준비 시간은 제외한다. Jenkins 전체 빌드 시간과 직접 비교하지 않는다.
최종 주문 검사는 실제 Node `v24.22.2`를 실행해 확인했으며 NODE_OPTIONS 진단/지연 파일도 사용하지 않았다.
검사 입력 네 파일의 정규화 SHA-256을 기록하고 제어 검사에 사용한 수정본과 동일함을 대조했다.

#45의 성공 검증 기준 `fc80e399`에서 최신 대상 `8c461a2c`를 포함한 최종 커밋을 실제 Git 이력으로 비교한
선택 결과는 `order`와 `deployment`다.
DB/events/operations/customer/consultation 회귀와 변경 없는 앱 이미지 배포 선택은 비활성이다.
실제 배포 선택은 별도의 운영 배포 이력을 기준으로 하므로 미배포/비정상 앱의 재선택을 강제로 막지는 않는다.
공통 선택 정책과 055 기준은 변경하지 않았다. 전체 자동 계획 584개와 주문 72개를 유지하며 새 자동 검사를 추가하지 않았다.
이번 동시성 사례의 원본 HTTP 부하만 12건에서 1건으로 줄였다.

## 근거와 제외 범위

Git 제외 경로 `msa/liquibase/verification-logs/build-45/`에 실제 #45/#46 원문과 보관된 order 로그,
동일 CI 런타임의 `exact-before-queue/`, `exact-after-queue/`, `exact-full/`, `linux-unit.log`를 보존한다.
`startup-before/`, `startup-after/`에는 상담 시작 지연의 수정 전 실패와 수정 후 검사를 보존한다.
`exact-after-queue/concurrency-evidence.json`은 같은 요청 ID의 원본 1건과 MSA 12건이 모두 200임을 대조한다.
`final-image-inputs.json`에는 수정 전후 실행 이미지 대조 결과를 보존한다.
`stale-43-cleanup.log`에는 중지 전 소유권/ID와 중지 결과를 기록했다.

이번 수정은 검증 실행기와 실패 안내에 한정한다. 실제 운영 API/DB/프론트/AI 코드는 변경하지 않았다.
운영 Jenkins의 새 소스 전체 빌드와 운영 배포 결과는 별도로 확인해야 한다.
