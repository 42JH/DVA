// 태그 — 높이 24 · 캡션 17/600 · 모서리 12. kind: blue(파랑) · red(빨강) · gray(회색) · outline(흰 바탕 회색 선, 05 실패 유형)
// onTinted: 선택 · 호버 줄 위에서는 바탕이 줄 바탕과 겹쳐 사라지므로 흰 바탕
const KIND = {
  blue: 'bg-action-soft text-action',
  red: 'bg-danger-soft text-danger',
  gray: 'bg-bg text-sub',
  outline: 'bg-surface text-sub ring-1 ring-muted ring-inset', // 선도 안쪽 ring — 색 태그와 폭 동일
} as const

export type TagKind = keyof typeof KIND

export function Tag({
  kind = 'gray',
  onTinted,
  children,
}: {
  kind?: TagKind
  onTinted?: boolean
  children: string
}) {
  const color =
    onTinted && kind !== 'outline' ? `bg-surface ${KIND[kind].split(' ')[1]}` : KIND[kind]
  return (
    <span
      className={`inline-flex h-6 items-center rounded-full px-2.5 text-caption font-semibold whitespace-nowrap ${color}`}
    >
      {children}
    </span>
  )
}
