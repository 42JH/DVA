# S11 의존성 보안 정리

기준: 2026-11-06, 현재 체크아웃의 npm 잠금파일. backend·MSA 서비스 5개·공통 이벤트 패키지의 7개 설치 경계에서 전체/운영 의존성을 각각 검사한다. 소스·실제 env·비밀값은 취약점 조회에 전달하지 않는다.

## 변경

- backend 및 MSA: 취약 범위의 `minimatch >=7 <11.0.1`만 `11.0.5`로 제한적으로 교체한다. 다른 API를 사용하는 기존 `3.x`는 일괄 교체하지 않는다.
- MSA: 취약 범위의 `glob >=9 <14.0.2`만 `14.0.3`으로 교체한다.
- Node 24, NestJS 11, 기존 ESLint/Jest major와 업무 의존성은 유지한다. 호환성은 각 설치 경계의 깨끗한 설치·lint·테스트·빌드로 확인한다.
- 기존 multer·Swagger js-yaml·body-parser override는 유지한다. 이번 재검사 전에도 해당 수정 버전이 잠금파일에 반영돼 있었다.
- 공통 이벤트 패키지는 검사 대상이며, 수정이 필요한 항목이 없으면 잠금파일을 불필요하게 바꾸지 않는다.

공식 공지:

- [minimatch globparts 자원 증폭](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)
- [glob AbortSignal 취소 후 탐색 지속](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4)

## 남는 deepmerge 항목

`deepmerge 4.3.1`의 [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)는 npm에서 Low로 보고한다. 조회 시 npm 공식 최신 릴리스도 4.3.1이며 검증 가능한 공식 수정 릴리스가 없다. 감사 도구의 Nest CLI major 교체나 Jest 과거 major로의 제안을 자동 적용하지 않는다. 취약점 건수만 줄이기 위한 구버전 다운그레이드도 하지 않는다.

격리된 검사 이미지에서 `jest-config`와 `fork-ts-checker-webpack-plugin`의 설정 처리 코드가 이 패키지를 불러오는 것을 확인했다. MSA 5개 운영 이미지 모두에서 `require.resolve('deepmerge')`가 `MODULE_NOT_FOUND`로 거절되는 것도 검사했다. 현재 운영 HTTP 입력으로 도달하는 설치 경로는 확인되지 않았다. 신뢰하지 않는 저장소·설정은 빌드 코드 실행 권한으로 취급하며 운영 비밀을 주지 않는다. CI 격리의 구조 변경은 S14 범위다.

수정 릴리스 부재에 따른 잔여 위험으로 기록하며 2026-11-13에 공식 수정 릴리스와 상위 도구의 제거 여부를 재검토한다. 자동 알림·갱신 작업을 생성한 것은 아니다. 부모 패키지 전파 집계를 독립적인 취약점 수로 합산하지 않는다.

## 검증과 영향

수정 후 npm 공식 조회 결과:

| 설치 경계 | 전체 의존성 | 운영 의존성 |
| --- | --- | --- |
| backend | 0 | 0 |
| MSA customer/order/delivery/consultation/operations 각각 | Low 8, Moderate/High/Critical 0 | 0 |
| MSA shared/events | 0 | 0 |

각 MSA의 Low 8은 같은 deepmerge 공지가 상위 패키지에 전파된 영향 항목이다. 서로 다른 취약점 8개나 서비스 전체의 고유 취약점 40개를 의미하지 않는다. 잠금파일 비교에서 운영 패키지의 버전·무결성 값은 변경되지 않았다.

잠금파일을 갱신할 때 설치 스크립트를 실행하지 않는다. 새로 도입되는 패키지의 설치 스크립트 유무와 Node 지원 범위를 확인한다. Python 고정 설치·전체 npm 설치 정책·상시 CI 감사 도입은 S12의 별도 작업이다.

검증은 잠금파일을 이용한 깨끗한 설치, 전체/운영 npm 감사, monolith 전체 Docker 검사, MSA 서비스별 lint·unit/e2e·빌드와 운영 이미지 설치로 구분한다. 실제 운영 API·배포·원격 CI 검증과 혼동하지 않는다. 감사 결과는 실행 시점에 알려진 공지 기준이며 패키지의 무해성이나 미래 취약점 부재를 보장하지 않는다.

이번 변경에서 monolith Docker 검사 994개(실패/취소/생략 0), MSA 5개 서비스의 lint·unit/e2e·빌드·운영 이미지 생성이 통과했다. S10 관측 통합 검증 10개와 기존 배포·복구 모의 검사도 통과했다. MSA 전체 동등성 검증기는 이번에 다시 실행하지 않았으며 추가 env fixture 3개의 문법만 확인했다. Windows sandbox의 직접 검사는 루프백 EACCES로 실패해 격리 Docker의 전체 검사 결과와 구분한다.

AI·프론트의 URL·인증 헤더·JSON 필드와 DB 스키마는 변경하지 않는다. 새 이미지 빌드가 필요하며 실제 AI/프론트 브랜치의 빌드 코드는 수정하지 않는다.
