# DVA 관리자 웹 (frontend)

React 19 · TypeScript · Vite · Tailwind CSS v4 · React Router · TanStack Query · MSW

## 실행

```bash
cp .env.example .env.local   # PowerShell: copy .env.example .env.local
npm install
npm run dev                  # http://localhost:5173
```

PowerShell에서 `npm`이 실행 정책 때문에 막히면 `npm.cmd`로 실행합니다.

| 환경 변수 | 뜻 |
|---|---|
| `VITE_API_BASE_URL` | API 기본 경로. 기본 `/api` (버전 접두사 없음) |
| `VITE_USE_MOCK` | `true`면 MSW 가짜 API 사용. 가짜가 없는 요청은 백엔드로 감 |

개발 서버는 `/api`를 떼고 `http://localhost:3000`(백엔드)으로 넘깁니다 — 배포 nginx(`infra/nginx/default.conf`)와 같은 동작.

가짜 로그인: 아이디 `jaehoon.lee@dver.co.kr`, 비밀번호는 아무 값.

## 구조 — MVVM

```
src/
  app/              라우터 · 전역 Provider · 틀(레이아웃) · 로그인 확인
  features/<기능>/
    model/          타입 · API 호출 · 쿼리 키      — React를 모름
    viewmodel/      use<화면>ViewModel 훅        — 상태 · 동작 · 서버 데이터(React Query)
    view/           화면 컴포넌트                 — ViewModel 값만 그림
  shared/
    api/client.ts   공통 HTTP 클라이언트 (명세서 1장 공통 규약)
    auth/token.ts   Access Token 보관
    styles/global.css  Tailwind 진입점 + 디자인 토큰(@theme) + 기본 스타일
    ui/             공통 컴포넌트 (만들 때 추가)
  mocks/            MSW 가짜 API (handlers/<기능>.ts)
```

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
