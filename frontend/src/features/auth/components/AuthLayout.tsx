import type { ReactNode } from 'react'
import box from '@/features/auth/assets/illust-box.webp'
import phone from '@/features/auth/assets/illust-phone.webp'
import truck from '@/features/auth/assets/illust-truck.webp'
import logo from '@/features/auth/assets/logo.svg'

// 00 네 화면 공통 틀 (디자인/목업 '00_로그인' 10/30) — 왼쪽 576 그림 판 + 오른쪽 가운데 440 칸(아이콘 · 제목 · 설명 · 내용)
// 그림 판은 디자인 좌표(576×1024) 그대로 두고 세로 가운데 — 화면이 1024보다 낮으면 위아래가 같이 잘림. 로고만 판 위에 고정
// 제목 40은 글자 규칙(최대 28)의 예외 — 디자인 그대로
const BLOB = 'absolute rounded-full bg-surface/80 shadow-[0_10px_28px_rgba(107,127,160,0.18)]'

export function AuthLayout({
  icon,
  title,
  sub,
  children,
}: {
  icon?: ReactNode
  title: string
  sub?: string
  children: ReactNode
}) {
  return (
    // 좁은 창(1280 미만)에선 그림 판이 줄고(오른쪽이 잘림) 오른쪽 칸은 최소 520 — 440 칸 양옆 여백 (반응형)
    <div className="grid h-full grid-cols-[minmax(0,1fr)_minmax(520px,1fr)] xl:grid-cols-[576px_1fr]">
      <aside className="relative overflow-hidden bg-action-soft">
        <div className="absolute top-1/2 left-0 h-[1024px] w-[576px] -translate-y-1/2">
          <i className={`${BLOB} top-[163px] left-[194px] size-[120px]`} />
          <i className={`${BLOB} top-[641px] left-[458px] size-[100px]`} />
          <i className={`${BLOB} top-[909px] left-[309px] size-[254px]`} />
          <img
            src={truck}
            alt=""
            fetchPriority="high"
            className="absolute top-[89px] left-[296px] w-[252px]"
          />
          <img src={box} alt="" className="absolute top-[623px] left-[408px] w-[124px]" />
          <img src={phone} alt="" className="absolute top-[689px] left-[52px] w-[192px]" />
          <div className="absolute top-[405px] left-[52px]">
            <p className="text-[40px] leading-[1.4] font-bold">
              AI가 받고
              <br />
              우리가 완성합니다
            </p>
            <p className="mt-6 text-label text-sub">
              주문 검수부터 상담 품질 개선까지,
              <br />
              디버 택배 AI 전화 접수 관리자 웹
            </p>
          </div>
        </div>
        <img src={logo} alt="dver" className="absolute top-10 left-10 h-[30px]" />
      </aside>

      <main className="grid place-items-center overflow-y-auto py-10">
        <div className="flex w-[440px] flex-col items-center">
          {icon}
          <h1 className={`text-[40px] leading-[1.4] font-bold ${icon ? 'mt-4' : ''}`}>{title}</h1>
          {sub && <p className="mt-3 text-center text-label whitespace-pre-line text-sub">{sub}</p>}
          <div className="mt-10 flex w-full flex-col">{children}</div>
        </div>
      </main>
    </div>
  )
}

/** 아래 줄 '계정이 없으신가요? 회원가입' 같은 질문 + 링크 */
export function AuthFooter({ children }: { children: ReactNode }) {
  return (
    <p className="mt-12 flex justify-center gap-2 text-label font-semibold text-sub">{children}</p>
  )
}

/** 버튼 바로 위 오류 한 줄 — 자리는 늘 비워 둠(문구가 떠도 버튼이 안 움직이게) */
export function AuthError({ message }: { message: string | null }) {
  return (
    <p
      role="alert"
      className="mt-8 flex min-h-6 items-start gap-1.5 text-label font-semibold text-danger"
    >
      {message && (
        <>
          <span className="flex h-[1.4em] shrink-0 items-center">
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden
              className="size-[18px] shrink-0"
            >
              <circle cx="10" cy="10" r="8" />
              <path d="M10 6v5M10 13.75v.1" />
            </svg>
          </span>
          {message}
        </>
      )}
    </p>
  )
}
