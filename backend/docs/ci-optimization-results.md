# 백엔드 CI 최적화 검증 결과

2026-11-08, develop-backend `9f6c72e` 기반. 업무 소스·API·DB 스키마 변경 없이 CI 실행 방식만 변경했다. Linux Docker 29.6.2의 임시 PostgreSQL에서 순차 실행했으며 운영 DB에는 접근하지 않았다.

## 변경 범위 선택

| 프로필 | DB 통합 그룹 | DB 테스트 | DB 검증 시간 | 별도 운영/Nginx/HTTPS 테스트 |
| --- | ---: | ---: | ---: | ---: |
| full | 46 | 838 | 377.008초 | 23 통과 |
| faq | 13 | 235 | 96.204초 | 23 통과 |
| dashboard | 8 | 196 | 63.156초 | 23 통과 |

- DB 검증 시간은 `Backend integration checks` 출력이다. 의존성 설치·컴파일·단위 테스트·이미지 빌드·운영 smoke 시간은 제외했다. 첫 전체 빌드에는 새 의존성 레이어 설치가 포함됐고 후속 실행은 Docker 레이어 캐시를 사용하므로 전체 실행 시간은 직접 비교하지 않는다. Jenkins 서버의 보장된 단축률을 뜻하지 않는 로컬 단일 측정이다.
- 전체 빌드에서 컴파일·lint·format:check와 단위/결제 데모 테스트 218개, DB/운영 테스트 861개가 통과했다. 선택 규칙 검증 3개를 추가했으며 기존 테스트는 삭제하지 않았다. 선택 실행도 같은 단위 검증 레이어를 사용하고 운영 smoke 23개를 모두 실행한다.
- 최초 FAQ 선택 실행은 선행 주문 fixture가 없어 운영 주소 이력 검증 1개가 실패했다. 필수 주소 이력 그룹을 두 프로필의 공통 범위에 포함해 위 표의 FAQ·대시보드 실행이 통과했다. 검증 기대값은 완화하지 않았다.
- 선택 명령은 기존 `package.json` 그룹 전체와 실행 순서를 유지한다. CI 선택/Git diff/실행 명령 회귀 9개와 Linux 배포·복구·패키지 체크섬 회귀가 통과했다. 실패·취소·skip·todo는 위 최종 성공 실행에서 모두 0이다.

## 재현

저장소 루트에서 `node backend/scripts/check.cjs`는 전체 실행이다. Linux에서는 `BACKEND_TEST_PROFILE=faq node backend/scripts/check.cjs`, `BACKEND_TEST_PROFILE=dashboard node backend/scripts/check.cjs`로 선택 실행을 재현한다. 각각 독립적인 임시 DB와 네트워크를 만들고 종료 시 정리한다.

CI 설정·공통·인증·주문·결제·migration·의존성·모듈 배선·미분류 경로 및 FAQ/대시보드 혼합 변경은 전체 검증한다. 이번 MR 첫 병합도 CI 설정 변경이므로 전체 검증 대상이다.

실제 Jenkins Job 재실행·운영 배포 시간은 아직 측정하지 않았다.
