# DVA 관리자 웹 (frontend)

React 19 · TypeScript · Vite · Tailwind CSS v4 · React Router · TanStack Query · MSW

## 실행

```bash
npm install
npm run dev                    # http://localhost:5173 — 실제 백엔드(DEV_PROXY_TARGET)에 붙음
npm run dev -- --mode mock     # 목 API(MSW)로 — 백엔드 없이 개발 · 화면 확인
```

PowerShell에서 `npm`이 실행 정책 때문에 막히면 `npm.cmd`로 실행합니다.

환경 변수는 git에 있는 팀 공통 기본값을 모드에 맞게 자동으로 읽습니다. 따로 만들 파일은 없습니다.

- `npm run dev` → `.env.development` (목 API 끔)
- `npm run dev -- --mode mock` → `.env.mock` (목 API 켬)

내 컴퓨터에서만 바꿀 값은 `.env.development.local` · `.env.mock.local`에 둡니다(git에 안 올라감, 같은 모드의 기본값보다 우선). 예: 다른 백엔드에 붙일 때 `DEV_PROXY_TARGET=...`.
`.env.local`은 모드별 파일보다 약해서 그 값을 못 바꿉니다 (Vite 규칙: `.env.[모드].local` > `.env.[모드]` > `.env.local` > `.env`).

| 환경 변수            | 뜻                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `VITE_API_BASE_URL`  | API 기본 경로. 기본 `/api` (버전 접두사 없음)                                              |
| `VITE_USE_MOCK`      | `true`면 MSW 목 API 사용. 목 응답이 없는 조회는 백엔드로, 목 응답이 없는 쓰기는 501로 막음 |
| `DEV_PROXY_TARGET`   | 개발 서버가 `/api` 요청을 그대로 넘길 백엔드 주소 (브라우저 코드엔 안 들어감)              |
| `VITE_SCENARIO_TEST` | `false`면 시나리오 시험 화면과 반영 전 시험을 끔                                           |

개발 서버는 `/api` 경로를 그대로 `DEV_PROXY_TARGET`으로 넘깁니다(`vite.config.ts`) — 배포 nginx(`deploy/nginx-admin-web.conf`)와 같은 동작. 운영 빌드에는 목 API가 들어가지 않습니다.

목 모드 로그인 (`--mode mock`일 때, `src/mocks/handlers/auth.ts`). 비밀번호는 모두 `test1234`.

| 아이디     | 계정                       | 로그인하면                                                             |
| ---------- | -------------------------- | ---------------------------------------------------------------------- |
| `admin`    | 최고 관리자 (SYSTEM_ADMIN) | 모든 메뉴 · 관리자 권한 관리 보임                                      |
| `manager`  | 일반 관리자 (OPERATOR)     | 관리자 권한 관리 숨김                                                  |
| `pending`  | 승인 대기                  | 로그인 안 됨 — 실제 서버처럼 ACTIVE 계정만 (틀린 비밀번호와 같은 안내) |
| `inactive` | 비활성화                   | 로그인 안 됨 (위와 같음)                                               |

회원가입으로 만든 계정은 승인 대기라 로그인되지 않고, 새로고침하면 사라집니다.

## 구조 — 기능 기준 폴더

```
src/
  app/              Provider · 라우트 표(router.tsx) · 틀(AppLayout) · 가드(guards/) · 홈(home/) · 기능 밖 화면(routes/)
                    · 에러 경계(RouteError) · API 요청 형식 검사(contract/, 백엔드 DTO와 대조)
  shared/
    api/            client.ts(공통 HTTP · ApiError) · queryClient.ts · paging.ts
    auth/           session.ts(로그인 표시) · sessionApi.ts · useSession.ts   — 세션은 여러 기능이 써서 여기
    call/           통화 API · 녹취 재생(Player · useRecordingPlayer) · 대화 기록 — 통화 · 주문 · AI 상담가가 같이 씀
    customer/       고객 검색 API
    order/          주문 API · 주문 상세(useOrderDetail) · 상태 표시(look) — 주문 · 통화가 같이 씀
    lib/            useListParams · useSnapshotList · format · dateRange · search(띄어쓰기 · 초성) 등
    styles/         global.css (Tailwind 진입점 + 디자인 토큰 @theme)
    ui/             공통 부품 (index.ts에 모아 둠)
  features/<기능>/
    api/            타입 · API 호출 · xxxQueries(queryOptions)   — React를 모름
    hooks/          use<기능>… 훅 · 순수 계산                     — 상태 · 판단 · 서버 데이터(React Query)
    components/     화면 컴포넌트                                — 훅 값만 그림
    labels.ts       상태 코드 → 화면 문구 (문구가 있는 기능만)
  mocks/            개발용 목 API(MSW): handlers/<기능>.ts → handlers/index.ts, browser.ts
```

의존 방향은 `shared → features → app`, 기능 안에서는 `components → hooks → api`. 기능 폴더끼리는 import하지 않는다.
`@/`는 `src/`. 같은 기능 안은 상대 경로로 가져온다. 구조 규칙(기능 폴더끼리 import 금지 등)은 `eslint.config.js`가 검사한다.

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

## 출처 · 오픈소스

코드는 팀이 직접 작성했습니다. 아래는 화면에 들어가는 외부 리소스와 쓰는 오픈소스입니다. 라이선스 원문은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.

| 구분        | 이름                                                                                                                                                   | 라이선스                 | 쓰는 곳                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------- |
| 그림 · 로고 | 로그인 그림 3개 · DVA 로고 · 탭 아이콘                                                                                                                 | 팀 제작 (생성형 AI 활용) | `src/features/auth/assets`, `src/shared/assets`, `public/favicon.png` |
| 아이콘      | [Lucide](https://lucide.dev) (Feather에서 갈라져 나옴)                                                                                                 | ISC (Feather 부분 MIT)   | `src/shared/ui/controls.tsx`의 선 아이콘 모양을 바탕으로 그림         |
| 글꼴        | [Pretendard](https://github.com/orioncactus/pretendard) v1.3.9                                                                                         | SIL OFL 1.1              | `index.html` — jsDelivr CDN에서 받음 (파일을 저장소에 넣지 않음)      |
| 외부 서비스 | 카카오 우편번호 서비스                                                                                                                                 | 서비스 이용 약관         | 주소 검색 창 (`react-daum-postcode`로 띄움)                           |
| 라이브러리  | React · React DOM · React Router · TanStack Query · Tailwind CSS · react-markdown · remark-gfm · remark-breaks · read-excel-file · react-daum-postcode | MIT                      | `package.json` dependencies                                           |
| 개발 도구   | Vite · MSW · ESLint · Prettier · tsx                                                                                                                   | MIT                      | 빌드 · 목 API · 검사                                                  |
| 개발 도구   | TypeScript                                                                                                                                             | Apache-2.0               | 타입 검사                                                             |
