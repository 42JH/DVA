import { CHIP_CLASS, KIND_BG, type CallKind } from '@/shared/lib/callKind'

// 상담 유형 칩 — 04 줄 · 06 머리 · 주문 상세 '관련 통화' (모양 · 색 = shared/lib/callKind)
// small = 04 목록 줄 (11/06 시안) — 테두리 1 · 둥근 알약 · 위아래 4 · 좌우 12 · 글자 12/500 · 글자색 = 테두리색
const SMALL =
  'inline-flex h-6 shrink-0 items-center rounded-full border px-3 text-[12px] font-medium whitespace-nowrap leading-[22px]'
const SMALL_COLOR: Record<CallKind, string> = {
  accept: 'border-[#3182f6] text-[#3182f6]',
  lookup: 'border-[#fe9800] text-[#fe9800]',
  cancel: 'border-[#f04452] text-[#f04452]',
  faq: 'border-[#8b95a1] text-[#8b95a1]',
}

export function KindChips({
  kinds,
  small,
}: {
  kinds: { kind: CallKind; label: string }[]
  small?: boolean
}) {
  return kinds.map((k) => (
    <span
      key={k.kind}
      className={small ? `${SMALL} ${SMALL_COLOR[k.kind]}` : `${CHIP_CLASS} ${KIND_BG[k.kind]}`}
    >
      {k.label}
    </span>
  ))
}

/** 아직 분석 전인 통화 — 칩 자리에 같은 모양의 회색 칩 (11/05 사용자: 글자만 떠 있어 어색). 줄에 올려도(회색 바탕) 보이게 테두리 */
export function PendingChip({ small }: { small?: boolean }) {
  return (
    <span
      className={
        small
          ? `${SMALL} border-line text-muted`
          : `${CHIP_CLASS} bg-bg text-sub ring-1 ring-line ring-inset`
      }
    >
      분석 전
    </span>
  )
}
