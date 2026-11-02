import type { ButtonHTMLAttributes } from 'react'

// 버튼 — 와이어프레임 공통: 높이 40(표 안 32 · 목록 맨 윗줄 48) · 모서리 8 · 좌우 20 · 라벨 18/600
// kind: primary(남색) · normal(흰 바탕 선) · danger(빨강 바탕) · dangerLine(흰 바탕 빨강 선). 비활성은 어느 kind든 회색
// aria-disabled: 회색으로 보이지만 누를 수는 있음 (00 로그인 — 크롬 자동 완성 값은 첫 클릭 전엔 안 읽혀서 진짜 disabled면 첫 클릭이 버려짐)
// 선은 border가 아니라 안쪽 ring — 선 있는 버튼과 없는 버튼의 폭(라벨 + 40)과 글자 자리가 똑같아야 해서
const KIND = {
  primary: 'bg-action text-white',
  normal: 'bg-surface text-ink ring-1 ring-line ring-inset',
  danger: 'bg-danger text-white',
  dangerLine: 'bg-surface text-danger ring-1 ring-danger ring-inset',
} as const

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: keyof typeof KIND
  small?: boolean // 표 안 32
  tall?: boolean // 목록 맨 윗줄 48 (검색칸 48과 같은 높이 — 09 [FAQ 추가])
}

export function Button({ kind = 'normal', small, tall, className = '', ...rest }: Props) {
  return (
    <button
      type="button"
      {...rest}
      className={`${small ? 'h-7' : tall ? 'h-10' : 'h-9'} rounded-lg px-5 text-label font-semibold whitespace-nowrap ${KIND[kind]} disabled:bg-bg disabled:text-muted disabled:ring-1 disabled:ring-line disabled:ring-inset aria-disabled:bg-bg aria-disabled:text-muted aria-disabled:ring-1 aria-disabled:ring-line aria-disabled:ring-inset ${className}`}
    />
  )
}
