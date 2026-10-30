# DVA 관리자 웹 (frontend)

React 19 · TypeScript · Vite · Tailwind CSS v4 · React Router · TanStack Query · MSW

## 실행

```bash
npm install
npm run dev                  # http://localhost:5173
```

PowerShell에서 `npm`이 실행 정책 때문에 막히면 `npm.cmd`로 실행합니다.

환경 변수는 `.env.development`(git에 있음, 팀 공통 기본값 — 가짜 API 켬)를 `npm run dev`가 자동으로 읽습니다. 따로 만들 파일은 없습니다.
내 컴퓨터에서만 바꿀 값은 `.env.development.local`에 둡니다(git에 안 올라감, `.env.development`보다 우선). 예: 실제 백엔드에 붙일 때 `VITE_USE_MOCK=false`.
`.env.local`은 `.env.development`보다 약해서 `VITE_USE_MOCK`을 못 바꿉니다 (Vite 규칙: `.env.development.local` > `.env.development` > `.env.local` > `.env`).

| 환경 변수           | 뜻                                                         |
| ------------------- | ---------------------------------------------------------- |
| `VITE_API_BASE_URL` | API 기본 경로. 기본 `/api` (버전 접두사 없음)              |
| `VITE_USE_MOCK`     | `true`면 MSW 가짜 API 사용. 가짜가 없는 요청은 백엔드로 감 |

개발 서버는 `/api`를 떼고 `http://localhost:3000`(백엔드)으로 넘깁니다 — 배포 nginx(`infra/nginx/default.conf`)와 같은 동작.

가짜 로그인 (`VITE_USE_MOCK=true`일 때, `src/mocks/handlers/auth.ts`). 비밀번호는 모두 `test1234`.

| 아이디     | 계정                       | 로그인하면                 |
| ---------- | -------------------------- | -------------------------- |
| `admin`    | 최고 관리자 (SYSTEM_ADMIN) | 홈 · 관리자 권한 관리 보임 |
| `manager`  | 일반 관리자 (SUPERVISOR)   | 홈 · 관리자 권한 관리 숨김 |
| `pending`  | 승인 대기                  | 승인 대기 중 화면          |
| `inactive` | 비활성화                   | 비활성화 화면              |

회원가입으로 만든 계정은 가입할 때 넣은 비밀번호로 로그인되고(승인 대기), 새로고침하면 사라집니다.

## 구조 — 기능 기준 폴더 (팀 컨벤션 v4, 노션)

```
src/
  app/              Provider · 라우트 표(router.tsx) · 틀(AppLayout) · 가드(guards/) · 기능 밖 화면(routes/) · 에러 경계
  shared/
    api/            client.ts(공통 HTTP · ApiError) · queryClient.ts · paging.ts
    auth/           token.ts · sessionApi.ts · useSession.ts   — 세션은 여러 기능이 써서 여기
    lib/            useListParams · format · dateRange
    styles/         global.css (Tailwind 진입점 + 디자인 토큰 @theme)
    ui/             공통 부품 (index.ts로만 import)
  features/<기능>/
    api/            타입 · API 호출 · xxxQueries(queryOptions)   — React를 모름
    hooks/          use<기능>… 훅                                — 상태 · 판단 · 서버 데이터(React Query)
    components/     화면 컴포넌트                                — 훅 값만 그림
    labels.ts       상태 코드 → 화면 문구
  mocks/            MSW 가짜 API: handlers/<기능>.ts → handlers/index.ts, browser.ts(개발) · node.ts(테스트)
```

의존 방향은 `shared → features → app`, 기능 안에서는 `components → hooks → api`. 기능 폴더끼리는 import하지 않는다.
`@/`는 `src/`. 규칙은 `eslint.config.js`가 검사한다. 자세한 규칙은 노션 '프론트엔드 컨벤션 v4'.

## 스타일 — Tailwind v4

- 설정 파일(`tailwind.config.js`) 없음. 토큰은 `src/shared/styles/global.css`의 `@theme`에 CSS 변수로 둔다.
- 토큰 이름이 곧 유틸리티: `--color-action` → `bg-action` `text-action` `border-action`, `--text-title` → `text-title`, `--spacing-sidebar` → `w-sidebar`.
- 기본 팔레트는 꺼 두었다(`--color-*: initial`). 토큰에 없는 색(`bg-blue-500` 등)은 안 먹히니 토큰에 추가해서 쓴다.
- 디자인 확정 시 `@theme`의 값만 바꾸면 전체 화면에 반영된다. 이름은 바꾸지 않는다.
- 클래스 정렬은 Prettier가 한다(`prettier-plugin-tailwindcss`). 커밋 전 `npm run format`.

- View → ViewModel → Model 한 방향으로만 부릅니다. ESLint가 막습니다(`eslint.config.js`).
  - View: Model · `shared/api` · React Query를 import하지 않음
  - Model: React · 화면 코드를 import하지 않음
- 서버 데이터는 ViewModel에서 React Query로, 화면 안에서만 쓰는 상태는 ViewModel의 `useState`로.
- 필요할 때 만듭니다. 쓰는 곳이 하나뿐인 추상화 · 헬퍼는 두 번째로 필요해질 때 `shared/`로 올립니다.

## 브랜치

`develop-fe`에서 `feat/<이슈 키>-<내용>`으로 따고, `develop-fe`로 MR. 머지 전 `npm run lint` · `npm run build` 통과.
