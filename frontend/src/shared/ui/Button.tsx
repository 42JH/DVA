import type { ButtonHTMLAttributes } from 'react'
import { ACTION_BADGE_SIZE, BUTTON_LOOK } from './actionBadge'

// 버튼 — 와이어프레임 공통: 높이 40(표 안 32 · 목록 맨 윗줄 48) · 모서리 8 · 좌우 20 · 라벨 18/600
// kind: primary(남색) · normal(흰 바탕 선) · danger(빨강 바탕) · dangerLine(흰 바탕 빨강 선). 비활성은 어느 kind든 회색
// 새 디자인(Figma 11/04~, FAQ부터): big = 높이 32 · 폭 76 이상 · 글자 20/600, kind brand(파랑) · brandLine(파랑 선) · gray(회색 — 취소)
// aria-disabled: 회색으로 보이지만 누를 수는 있음 (00 로그인 — 크롬 자동 완성 값은 첫 클릭 전엔 안 읽혀서 진짜 disabled면 첫 클릭이 버려짐)
// 선은 border가 아니라 안쪽 ring — 선 있는 버튼과 없는 버튼의 폭(라벨 + 40)과 글자 자리가 똑같아야 해서
// 모양 · 색은 Btn과 같은 규칙(actionBadge.ts BUTTON_LOOK, 11/11) — 옛 kind 이름은 그대로 두고 모양만 맞춤
const KIND = {
  editBadge: BUTTON_LOOK.edit,
  deleteBadge: BUTTON_LOOK.danger,
  primary: BUTTON_LOOK.solid,
  normal: BUTTON_LOOK.plain,
  danger: BUTTON_LOOK.solidDanger,
  dangerLine: BUTTON_LOOK.danger,
  brand: BUTTON_LOOK.solid,
  brandLine: BUTTON_LOOK.line,
  gray: BUTTON_LOOK.plain,
} as const

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: keyof typeof KIND
  small?: boolean // 표 안 32
  tall?: boolean // 목록 맨 윗줄 48 (검색칸 48과 같은 높이 — 09 [FAQ 추가])
  big?: boolean // 새 디자인 버튼 (위 주석)
}

export function Button({ kind = 'normal', small, tall, big, className = '', ...rest }: Props) {
  return (
    <button
      type="button"
      {...rest}
      className={`${kind === 'editBadge' || kind === 'deleteBadge' ? ACTION_BADGE_SIZE : `${big ? 'h-8 min-w-19 px-4 text-card' : `${small ? 'h-7' : tall ? 'h-10' : 'h-9'} px-5 text-label`} rounded-lg font-semibold`} shrink-0 whitespace-nowrap ${KIND[kind]} disabled:bg-bg disabled:text-muted disabled:ring-1 disabled:ring-line disabled:ring-inset aria-disabled:bg-bg aria-disabled:text-muted aria-disabled:ring-1 aria-disabled:ring-line aria-disabled:ring-inset ${className}`}
    />
  )
}
