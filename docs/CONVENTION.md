# Git 협업 컨벤션

## 1. 브랜치 구조

```text
main
└── develop
    ├── develop-fe
    │   └── 타입/작업내용
    ├── develop-backend
    │   └── 타입/작업내용
    └── develop-ai
        └── 타입/작업내용
```

| 브랜치 | 역할 |
| --- | --- |
| `main` | 배포 및 발표 가능한 안정 버전 |
| `develop` | Frontend·Backend·AI 통합 및 연동 테스트 |
| `develop-fe` | Frontend 작업 통합 |
| `develop-backend` | Backend 작업 통합 |
| `develop-ai` | AI 작업 통합 |

각 작업 브랜치는 해당 파트의 `develop-*` 브랜치에서 생성한다.

## 2. 작업 브랜치 이름

형식은 `타입/작업내용`을 사용한다.

- 작업내용은 영문 소문자와 하이픈(`-`)으로 작성한다.
- 작업 브랜치는 가능한 짧게 유지한다.

예시:

```text
feature/order-list
fix/auth-token
refactor/order-validation
design/dashboard
chore/schema-update
```

| 타입 | 용도 |
| --- | --- |
| `feature` | 새로운 기능 개발 |
| `fix` | 버그 수정 |
| `refactor` | 코드 리팩터링 |
| `design` | UI 및 디자인 수정 |
| `docs` | 문서 작성·수정 |
| `test` | 테스트 코드 작업 |
| `build` | 빌드 및 의존성 관련 작업 |
| `ci` | CI/CD 설정 작업 |
| `chore` | 기타 유지보수 작업 |

## 3. Jira 연결

- 작업 MR(PR) 하나를 Jira Task 하나의 처리 단위로 관리한다.
- Jira 이슈 키는 브랜치 이름 대신 MR 제목에 포함한다.
- MR 본문에 해당 Jira 이슈 링크를 작성한다.
- 서로 다른 Task의 변경을 하나의 작업 MR에 섞지 않는다.
- 파트 간 통합 MR은 포함된 작업 MR과 Jira 이슈를 정리한다.

MR 제목 예시:

```text
[S15P31D109-106] 기업 사번 및 상태 제약 변경
```

## 4. 작업 순서

1. 해당 파트의 `develop-*` 브랜치에서 작업 상태를 확인한다.
2. 원격 변경을 가져오고 기준 브랜치를 최신 상태로 갱신한다.
3. 작업 브랜치를 생성한다.
4. 변경을 작성하고 필요한 검증을 수행한다.
5. 작업 범위에 해당하는 파일만 커밋한다.
6. 작업 브랜치를 원격에 Push한다.
7. 해당 파트의 `develop-*` 브랜치를 대상으로 MR을 생성한다.
8. 리뷰와 검증을 마친 뒤 병합한다.
9. 병합 완료 후 작업 브랜치를 삭제한다.

Backend 작업 예시:

```text
develop-backend
    └── chore/schema-update
            └── MR → develop-backend
```

## 5. 병합 방향

```text
Frontend 작업 브랜치 → develop-fe ─┐
Backend 작업 브랜치  → develop-backend ─┼→ develop → main
AI 작업 브랜치       → develop-ai ──────┘
```

- 작업 브랜치는 해당 파트의 `develop-*` 브랜치로 병합한다.
- 파트별 작업물은 공통 `develop` 브랜치에서 통합한다.
- 전체 기능 및 통합 테스트를 완료한 안정 버전만 `main`으로 병합한다.

## 6. Merge Request 규칙

- `main`, `develop`, `develop-*` 브랜치에 직접 Push하지 않는다.
- 모든 변경은 MR을 통해 병합한다.
- 최소 1명 이상의 리뷰를 거친 뒤 병합한다.
- 병합 전에 충돌 여부를 확인하고 해결한다.
- 변경에 필요한 빌드·테스트·기본 동작 검증을 수행한다.
- MR 본문에는 변경 내용, 관련 Jira 이슈, 검증 결과를 작성한다.
- 미검증 사항과 후속 작업이 있다면 명시한다.

## 7. 병합 방식

### 작업 브랜치 → 파트별 develop

Squash Merge를 권장한다.

작업 중 생성한 여러 커밋을 Jira Task 단위의 커밋으로 정리한다.

### 파트별 develop → develop → main

기존 작업 단위의 커밋 이력을 유지하는 방식으로 병합한다.