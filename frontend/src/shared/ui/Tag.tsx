// 태그 — 높이 24 · 캡션/600 · 모서리 12. 모양은 하나(옅은 바탕 + 진한 글자), kind는 색만: blue · red · gray · outline(= 더 옅은 회색: 문의 · 분석 전 · 저장됨) · live(= 파랑: 진행 중)
// 11/02 사용자: 선(ring) · 앞 점(●) 변형은 없앰 — 03 '접수 중단'이 다른 알약과 모양이 달랐음
// onTinted: 선택 · 호버 줄 위에서는 바탕이 줄 바탕과 겹쳐 사라지므로 흰 바탕
const KIND = {
  blue: 'bg-action-soft text-action',
  red: 'bg-danger-soft text-danger',
  gray: 'bg-bg text-sub',
  outline: 'bg-bg text-muted',
  live: 'bg-action-soft text-action',
} as const

export type TagKind = keyof typeof KIND

export function Tag({
  kind = 'gray',
  onTinted,
  fixed,
  children,
}: {
  kind?: TagKind
  onTinted?: boolean
  fixed?: boolean // 표 열의 알약: 폭 96 고정(가장 긴 '배송·운송장' 기준) + 글자 가운데 — 열 안 알약 크기가 제각각이지 않게 (11/02 사용자)
  children: string
}) {
  const color = onTinted ? `bg-surface ${KIND[kind].split(' ')[1]}` : KIND[kind]
  return (
    <span
      className={`inline-flex h-6 items-center rounded-full px-2.5 text-caption font-semibold whitespace-nowrap ${fixed ? 'w-24 justify-center' : ''} ${color}`}
    >
      {children}
    </span>
  )
}
