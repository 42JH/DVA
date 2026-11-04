import { CHIP_CLASS, KIND_BG, type CallKind } from '@/shared/lib/callKind'

// 상담 유형 칩 — 04 줄 · 06 머리 · 주문 상세 '관련 통화' (모양 · 색 = shared/lib/callKind)
export function KindChips({ kinds }: { kinds: { kind: CallKind; label: string }[] }) {
  return kinds.map((k) => (
    <span key={k.kind} className={`${CHIP_CLASS} ${KIND_BG[k.kind]}`}>
      {k.label}
    </span>
  ))
}

/** 아직 분석 전인 통화 — 칩 자리에 같은 모양의 회색 칩 (11/05 사용자: 글자만 떠 있어 어색). 줄에 올려도(회색 바탕) 보이게 테두리 */
export function PendingChip() {
  return <span className={`${CHIP_CLASS} bg-bg text-sub ring-1 ring-line ring-inset`}>분석 전</span>
}
