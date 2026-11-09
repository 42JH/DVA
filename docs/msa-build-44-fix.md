# Jenkins MSA #44 샌드박스 오류 수정

Jira: [S15P31D109-160](https://ssafy.atlassian.net/browse/S15P31D109-160)
관련 MR: [!395](https://lab.ssafy.com/s15-final/S15P31D109/-/merge_requests/395)

## 확인된 실패와 계획

기존 SSH 키와 고정 호스트 키로 Jenkins 서버의 빌드 기록을 읽기 전용 조회했다.
#44는 `d61b900d3ee36ff622f270858629d09582bd3a2b`를 checkout했다.
배포 회귀 124개는 통과했고 `ci_verification.py record deployment`도 stamp 파일을 기록했다.
그 다음 Jenkinsfile 20행의 `env[동적 이름] = 값`이 아래 오류로 거부됐다.

```text
RejectedAccessException: Scripts not permitted to use staticMethod
org.codehaus.groovy.runtime.DefaultGroovyMethods putAt java.lang.Object java.lang.String java.lang.Object
at WorkflowScript.recordVerification(WorkflowScript:20)
```

뒤의 계약·이벤트·DB·업무·배포 단계는 앞선 오류 때문에 실행되지 않았다.
이전 Groovy 검증의 `env`는 일반 Map이어서 실제 Jenkins `EnvActionImpl`의 샌드박스 거부를 재현하지 못했다.
성공 기록과 Checkout 이력 승계의 두 쓰기 지점을 `env."MSA_VERIFIED_${...}" = 값`으로 수정했다.
일반 객체의 `putAt` 확장 호출 대신 Jenkins가 허용하는 속성 쓰기를 사용한다. 실행 코드 변경은 두 줄이다.

서버와 같은 Jenkins `2.580.1-jdk21` 이미지 digest와 설치 플러그인 98개의 SHA-256을 확인했다.
계정·credential·운영 설정을 복제하지 않고 네트워크/호스트 포트가 없는 로컬 일회성 Jenkins에서 검증했다.
실제 `CpsFlowDefinition(sandbox=true)`와 `EnvActionImpl`, Pipeline `sh`/`readFile`/CPS 중단·재개,
Python stamp 기록 및 `RunWrapper.getBuildVariables()`를 사용한다. 서명 승인과 보안 설정 완화는 하지 않는다.

수정 전 기록·승계의 두 오류를 재현하고 수정 후 7개 scope 기록, 이후 배포 실패에도 기록 보존,
중간 실패 빌드를 건너뛴 다음 빌드의 승계를 확인했다. Linux 배포 회귀도 함께 실행했다.

!395는 이미 병합됐으므로 해당 MR의 diff에 새 코드를 추가할 수 없다.
최신 develop-backend에서 `fix/msa-jenkins-sandbox` 후속 브랜치를 만들었으며 !395에 결과를 연결한다.

## 검증 결과

실행 소스는 `023e33f1`이며 `msa/Jenkinsfile`과 새 통합 회귀만 포함한다.
일반 Groovy Map 대신 실제 Pipeline을 `sandbox=true`로 실행했다.

| 사례 | 기대 결과 | 관측 결과 |
|---|---|---|
| 수정 전 성공 기록 | Python stamp 작성 후 `putAt` 거부 | 같은 예외·같은 `recordVerification` 20행에서 실패 |
| 수정 후 7개 scope 기록 | 모두 저장 후 의도한 후속 배포 실패까지 도달 | 7개 저장·자식 shell 전달·CPS 재개 후 의도한 실패 |
| 수정 전 Checkout 승계 | 저장된 이력을 `env[]`에 복원하다 거부 | 같은 `putAt` 예외로 실패 |
| 수정 후 Checkout 승계 | 중간 실패 빌드를 건너뛰어 7개 값 복원 | 원래 stamp 7개 일치·자식 shell 전달·빌드 SUCCESS |

첫째/셋째의 FAILURE는 수정 전 오류 재현이며, 둘째의 FAILURE는 기록 이후 장애를 의도적으로 발생시킨 것이다.
단순히 FAILURE를 허용하는 것이 아니라 각각 정확한 거부 서명/의도한 오류 메시지와 보존된 값까지 확인한다.
최종 통합 실행의 종료 코드는 0, `sandbox.json.passed`는 true다. 승인한 추가 서명은 시작/종료 모두 0개다.
Linux `python3 -m unittest discover -s msa/deploy/tests -v`도 **124개, 65.303초, OK**였다.
기존 자동 CI 테스트 수를 늘리지 않고 실제 샌드박스 회귀는 별도 격리 통합 검사로 둔다.

검증한 환경은 다음과 같다.

- Jenkins `2.580.1`, Java `21.0.12.1`, 공식 이미지 digest `sha256:a660310e39ade10631f774bacd5219de767dfd08947ea5c32a739b5e5bb382c1`.
- 서버의 플러그인 바이너리 98개 전부 SHA-256 일치, 격리 Jenkins에서 모두 active.
- script-security `1436.v1082791135e4`, workflow-cps `4395.v738456a_5da_6b_`,
  workflow-support `1015.v785e5a_b_b_8b_22`, workflow-job `1609.v8926e7962024`.
- 운영 DB/계정/credential/Job 설정은 복사하지 않았다. 테스트 이미지에는 실제 Python 기록기를 실행하기 위한 Python만 추가했다.
- DB/업무 성공 보고서는 이 샌드박스 검사의 fixture다. 실제 DB/이미지 검증까지 다시 실행한 결과로 확대하지 않는다.

## 재현 입력과 실행

`msa/deploy/tests/integration_jenkins_history.groovy`는 일회성 Jenkins의 init script다.
`MSA_JENKINS_SANDBOX_TEST=1`, 빈 Job 목록과 추가 승인 서명 0개를 확인한 뒤 실행하며 운영 home에 넣지 않는다.
`/test-input`에 아래 네 파일을 읽기 전용으로 제공한다.

- `Jenkinsfile.before`: `git show d61b900d:msa/Jenkinsfile`의 원문.
- `Jenkinsfile`: 수정된 `msa/Jenkinsfile` 원문.
- `ci_verification.py`, `ci_images.py`: 현재 `msa/parity/`의 기록기와 이미지 출처 검사기.

동일 이미지에 Python을 추가하고, 확인한 플러그인만 `/usr/share/jenkins/ref/plugins`에 읽기 전용으로 연결한다.
새 일회성 volume을 `/var/jenkins_home`에, 결과 디렉터리를 `/test-results`에 연결한다.
init script는 `/usr/share/jenkins/ref/init.groovy.d/msa-sandbox.groovy`로 연결한다.
실행 옵션은 `--network none`, 호스트 포트 미공개, `JAVA_OPTS=-Djenkins.install.runSetupWizard=false`다.
검사 완료 후 컨테이너는 결과 JSON을 기록하고 종료 코드 0/1로 종료한다.

전체 근거는 Git 제외 경로 `msa/liquibase/verification-logs/build-44/`에 보존한다.
`console.log`는 실제 #44 원문, `server-plugins.txt`와 `plugin-versions.json`은 서버 바이너리 출처다.
`red/`는 수정 전 후보가 실제 거부로 검증에 실패한 결과이고,
`green-final/`은 네 조건을 모두 확인한 최종 실행의 개별 Pipeline 로그와 `sandbox.json`이다.
`linux-unit.log`와 `verification.json`에 기존 회귀·입력 해시·최종 집계가 있다.

## 적용과 미검증 범위

운영 Jenkins의 승인 목록과 보안 설정은 변경하지 않았다. 앱/API/DB/프론트/AI 코드도 변경하지 않았다.
공식 `dva-msa` Job 재실행과 운영 배포는 하지 않았으며, 병합 후 실행에서 확인해야 한다.
업무·DB 입력이 그대로이므로 이번 두 줄 수정 때문에 해당 전체 회귀를 다시 실행하지 않았다.
