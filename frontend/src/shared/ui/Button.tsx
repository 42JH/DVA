import type { ButtonHTMLAttributes } from 'react'
import { BUTTON_LOOK } from './actionBadge'

// 버튼 — 로그인 · 가입 · 안내 화면과 고객 탈퇴 확인 창에서 씀 (나머지 화면은 controls.tsx의 Btn)
// kind: primary(색 채움) · normal(흰 바탕 선) · danger(빨강 채움). 비활성은 어느 kind든 회색
// aria-disabled: 회색으로 보이지만 누를 수는 있음 (00 로그인 — 크롬 자동 완성 값은 첫 클릭 전엔 안 읽혀서 진짜 disabled면 첫 클릭이 버려짐)
// 모양 · 색은 Btn과 같은 규칙 (actionBadge.ts BUTTON_LOOK, 11/11)
const KIND = {
  primary: BUTTON_LOOK.solid,
  normal: BUTTON_LOOK.plain,
  danger: BUTTON_LOOK.solidDanger,
} as const

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: keyof typeof KIND
  tall?: boolean // 한 단계 높게 (로그인 · 가입의 확정 버튼)
}

export function Button({ kind = 'normal', tall, className = '', ...rest }: Props) {
  return (
    <button
      type="button"
      {...rest}
      className={`${tall ? 'h-10' : 'h-9'} shrink-0 rounded-lg px-5 text-label font-semibold whitespace-nowrap ${KIND[kind]} disabled:bg-bg disabled:text-muted disabled:ring-1 disabled:ring-line disabled:ring-inset aria-disabled:bg-bg aria-disabled:text-muted aria-disabled:ring-1 aria-disabled:ring-line aria-disabled:ring-inset ${className}`}
    />
  )
}
