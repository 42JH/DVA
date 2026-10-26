import type { ButtonHTMLAttributes } from 'react'

// 버튼 — 와이어프레임 공통: 높이 40(표 안 32) · 모서리 8 · 좌우 20 · 라벨 18/600
// kind: primary(남색) · normal(흰 바탕 선) · danger(빨강 바탕) · dangerLine(흰 바탕 빨강 선). 비활성은 어느 kind든 회색
const KIND = {
  primary: 'bg-action text-white',
  normal: 'border border-line bg-surface text-ink',
  danger: 'bg-danger text-white',
  dangerLine: 'border border-danger bg-surface text-danger',
} as const

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: keyof typeof KIND
  small?: boolean // 표 안 32
}

export function Button({ kind = 'normal', small, className = '', ...rest }: Props) {
  return (
    <button
      type="button"
      {...rest}
      className={`${small ? 'h-8' : 'h-10'} rounded-lg px-5 text-label font-semibold whitespace-nowrap ${KIND[kind]} disabled:border disabled:border-line disabled:bg-bg disabled:text-muted ${className}`}
    />
  )
}
