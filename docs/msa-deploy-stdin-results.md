# MSA 배포 입력 오류와 반복 검증 정리 결과

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)

기준: `develop-backend` `5d3bd1890454b85441e1c7891876ef2fb1ffb6e7`.
변경은 msa/docs에 한정하며 frontend/AI/backend의 실제 checkout·업무 API·SQL은 보존한다.

## #42 실패 원인과 수정

DB와 네 업무 회귀가 통과한 뒤 `Stage Application Images`에서 operations만 준비됐다.
해당 #42 소스는 `83ed416be42ab7d5fa88016a19655017b22a7713`이며 이번 수정 이전이다.
서비스 목록을 읽는 반복문과 SSH가 표준입력을 공유해 나머지 줄을 소비했다.
`Database Delivery`는 전송되지 않은 order 패키지를 찾다가 종료했고,
055 서비스 중지·DDL 전에 실패해 recovery.json도 아직 없었다.

6개 SSH 호출을 `ssh -n`으로 분리했다. SCP의 옵션과 프로토콜은 보존했다.
현재 Jenkins의 실제 준비/적용 shell 블록을 사용하는 회귀를 추가했으며,
수정 전 6개 테스트의 8개 실패를 확인하고 수정 후 통과했다.
첫 작성 때 fixture 디렉터리 누락으로 난 오류는 fixture를 고친 뒤 원인 재현과 구분했다.

실제 OpenSSH/SFTP를 사용하는 loopback 서버에서도 5개 서비스 모두 준비·적용됐다.
consultation의 준비 실패와 적용 실패는 각각 뒤의 서비스 실행을 차단했다.
이 검사의 원격 앱 핸들러는 fixture이며 실제 Kubernetes에 접근하지 않는다.

## 반복 실행과 구형 준비 정리

- DB·operations·customer·consultation·order·이벤트·배포 회귀의 성공 commit/build를 단계 통과 직후 기록한다.
  산출물 보관이나 이후 CD가 실패해도 기록을 유지하며, 생략된 빌드도 기존 기록을 이어받는다.
  Jenkins의 [공개 RunWrapper API](https://javadoc.jenkins.io/plugin/workflow-support/org/jenkinsci/plugins/workflow/support/steps/build/RunWrapper.html)로 이전 빌드 변수를 읽는다.
- DB 배포 pending과 전체 DB 회귀를 분리한다. migration·DB 실행기/검증기·고정 기준 정책이 같으면
  이전 성공 근거를 재사용하며 현재 이미지 ID와 출처 commit/build를 패키지에 남긴다.
  없는/잘못된/분기된 이력은 다시 검사한다. 실제 서버의 SQL fingerprint·정지·백업·DDL·복구는 유지한다.
- 업무 회귀도 배포 대상 때문에 확대하지 않고 각 suite의 마지막 성공 소스와 비교한다.
  필요한 checks/production 이미지만 만들며, 배포 없는 CI는 전송 패키지를 만들지 않는다.
  문서·수동 최종 진단 변경은 관련 없는 업무 회귀를 선택하지 않는다.
  inventory/최종 검증기/fixture 초기화 10개는 별도 빠른 Node 단계에서 유지한다.
- !371의 helper 변경 입력이 고정 055 원본과 동일함을 Git blob으로 확인했다.
  application/orders/manual-orders의 반복 비밀번호 해시·로그인 준비만 임시 CI 원본에서 세션 준비로 바꿨다.
  실제 인증 guard·권한 경로와 인증 전용 테스트는 유지한다. API·SQL·테스트 기대값을 수정하지 않았다.
  정확한 helper patch 외 backend 차이는 거부하며 최초 052 수동 진단 기준은 보존한다.

## 검증 소스와 환경

최종 전체 격리 실행 소스는 `4b360b07b1ce3b53ef6de642c3125b396e474a70`이다.
이전 전체 실행 `0a3d662309e003286e2a7864381cb13da26dc873`에서 발견한 fixture 교착을 수정했다.
중간 patch 정규화 `87057fc7b88642bafb7cec3783c00880c51c6e2f`에서는 독립 checkout의
provenance·원본 보호 5개·계약 6개·전체 diff 공백 검사를 추가 확인했다.
patch 형식 정규화 전후 생성된 backend 테스트 tree는 같았다.

원본은 `9624b7789ee7876648b6c56b5e7a4a7a5a9ef378`, backend tree
`12c6fa0f17354f53b28244d8b804bd564f1141be`로 유지했다.
helper 정리 후 임시 backend tree는 `f603390e3ccaedfef54b2dbd563a36dbdbd91fe0`이며,
그 차이는 승인된 helper patch와 정확히 같다.

운영 Jenkins와 분리된 로컬 Linux/Docker의 임시 DB에서 실제 검증했다.
공식 Jenkins와 CPU·메모리·캐시 조건이 다르므로 아래 시간을 공식 Job 단축률로 환산하지 않는다.

전체 실행과 동일 소스 재시도는 모두 성공했고 두 실행의 소유 이미지 정리도 성공했다.
아래 checks는 실행기가 기록하는 준비·명령·정리 단계를 포함하며 업무 단언 수를 뜻하지 않는다.

| 검증 | 실제 결과 | 시간(초) |
|---|---|---:|
| Linux 배포/선택/원본 보호 unittest | 135개 통과 | 14.254 |
| 고정 055 inventory·검증기·fixture 단위 | 10개 통과 | 0.268 |
| 실제 OpenSSH/SFTP, 5개 서비스·중간 실패 차단 | 통과 | 6.338 |
| 이벤트 PostgreSQL/HTTP 회귀 | 통과 | 5.389 |
| DB 전체 통합 | 621 checks, passed=true | 264.067 |
| operations 회귀 | 170 checks, passed=true | 252.831 |
| customer 회귀 | 61 checks, passed=true | 22.567 |
| consultation 회귀 | 154 checks, passed=true | 85.512 |
| order 회귀 | 210 checks, passed=true | 101.855 |
| 실제 PostgreSQL dump/restore 전환 fixture | 통과 | 9.145 |

operations의 checks 증가에는 한 번의 실제 잠금 경합 검사와 테스트 준비 파일 전달이 포함된다.
기존 업무 단언을 줄여 통과시킨 결과가 아니다.

## 동일 입력의 배포 재시도

별도 새 checkout과 새 release `9002`에서 검증 성공 이력 `4b360b07...:9001`을 전달했다.
배포 이력은 오래된 `cf85fe37...`로 둬 5개 앱과 order/consultation DB가 미배포인 상황을 만들었다.
실제 서버 상태를 변경한 재시도가 아니라 선택·이미지·패키징을 검증하는 격리 fixture다.

| 항목 | 첫 전체 실행 | 동일 입력 배포 재시도 |
|---|---|---|
| DB 전체 통합 | 실행, 264.067초 | 선택되지 않음 |
| 네 업무 회귀 | 모두 실행 | 모두 선택되지 않음 |
| 이벤트/배포 회귀 | 실행 | 선택되지 않음 |
| 빠른 계약/fixture 단위 | 10개 실행 | 10개 실행, 0.319초 |
| 이미지 준비 | 13개, 34.722초 | 앱 5개+Liquibase 1개, 4.886초 |
| DB 근거·패키지 | 전체 검사 보고서 생성 | 근거 재사용 0.271초, 패키징 4.086초 |
| 앱 패키지 | 배포 없는 CI로 생성하지 않음 | 5개 생성, 합계 16.341초 |

이미지 시간은 기존 BuildKit 캐시가 있는 동일 로컬 환경의 관측값이며 공식 Jenkins의 예상 시간이 아니다.
재시도의 DB 보고서는 이전 성공 source/build와 `unchanged-verification-inputs` 사유,
새 release의 현재 이미지 ID를 함께 기록했다. 없는 기록·변경 입력·잘못된 이미지의 거부 회귀도 통과했다.
배포할 DB와 앱은 그대로 선택돼 검사를 생략해도 미배포 변경이 누락되지 않았다.

## 검증 중 발견한 환경 의존성

첫 별도 Alpine 실행은 GNU realpath가 없는 도구 환경에서 실패했다.
Jenkins와 같은 GNU coreutils를 준비한 뒤 검사했다.
이후 실제 `MSA_CI_ORIGINAL_COMMIT`을 전달하니 기존 이미지 단위 테스트의 mock이
상속된 CI 변수에 의존하는 실패가 재현됐다. 해당 mock의 원본 변수를 격리한 뒤
실제 CI 변수 포함 전체 132개가 통과했다. 기대 오류/이미지 검증 조건은 유지했다.
최종 실행에는 fixture 회귀 선택 3개를 더해 135개가 통과했다.
원래 실패와 환경 준비 로그도 Git 제외 검증 경로에 보존한다.

## 테스트 데이터 초기화 교착 수정

첫 전체 실행은 DB·operations·customer 통과 후 consultation의 call-content 준비에서
PostgreSQL `40P01`로 실패했다. `TRUNCATE call_sessions ... CASCADE`와 production 워커가
서로 관련 테이블 잠금을 기다리는 경로였으며 실제 비교 API를 요청하기 전이었다.

14개 fixture의 36개 초기화 호출을 공통 준비 함수로 연결했다. 실제 DB 이름이
`dva_webhook_test`인 경우에만 FK로 연결된 테이블을 모두 `NOWAIT`로 잠그고 원래 TRUNCATE를 실행한다.
잠금 경합 `55P03`/`40P01`만 rollback 후 최대 5초 동안 재시도하며 그 외 SQL 오류는 즉시 실패한다.
API 호출·업무/권한 단언·초기화 대상·CASCADE/identity 옵션은 보존한다.

실제 임시 PostgreSQL에서 워커가 하위 테이블을 잠근 동안 초기화를 실행하고,
상위 테이블을 다시 읽는 워커까지 완료시켜 부분 잠금이 풀리는 것을 검증했다.
초기화 후 하위 행 제거와 identity 초기값도 확인했다. 준비 함수 단위 4개와
변경에 따른 회귀 선택 3개를 추가했으며 이 함수 변경은 소비하는 네 회귀를 모두 선택한다.

작업 checkout의 최신 backend를 참조한 inventory 실행은 후속 056/API 차이로 실패했다.
CI에서는 고정 원본 격리 후 동일 검사를 실행하며 기대값이나 기준 목록을 바꾸지 않았다.

## 실제 서버의 읽기 전용 확인

5개 앱과 PostgreSQL은 모두 desired/ready 1/1이었다.
배포된 #42 helper가 검토한 Git 원본과 해시가 같음을 확인한 뒤 SELECT만 실행했다.
조회 시점에는 5개 outbox 대기, 진행 통화와 미처리 PBX가 없었다.
이 결과는 이후 실제 배포 시점의 상태를 보장하지 않는다.

## 적용 시점과 한계

- 새 성공 기록이 없는 첫 공식 빌드와 검증 정책/입력 변경은 전체 검증할 수 있다.
  이후 동일 입력의 배포 재시도부터 통과한 DB·업무 회귀와 불필요한 이미지 준비를 생략한다.
  실패한 검사나 변경된 검사 입력을 성공으로 간주하지 않는다.
- Groovy 2.4.21에서 Jenkinsfile 구문·이력 함수·Checkout의 기록 승계를 실행 확인했다.
  공식 Jenkins Job과 실제 운영 055 중지/DDL/앱 rollout은 이 작업에서 실행하지 않았다.
- 기존 최초 052 전체 동등성 FAIL과 업무 API 23개 미구현은 별도 진단 결과로 남는다.
  이번 배포/검증 비용 수정은 전체 MSA 업무 구현 완료를 의미하지 않는다.
- 로그·JSON·Git bundle은 `msa/liquibase/verification-logs/deploy-stdin/`의 Git 제외 경로에 보존한다.
  최종 성공 실행의 요약은 그 아래 `final-fixture/integration-report.json`이며
  같은 폴더에 full/retry의 원본 보고서·실행 로그를 함께 보존한다.
