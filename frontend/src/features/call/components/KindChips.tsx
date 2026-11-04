import type { CallKind } from '@/features/call/api/callDto'

// 상담 유형 칩 (Figma '통화' 11/04 — 04 줄 · 06 머리) — 높이 28 · 최소 76 · 바탕색만, 글자 크기는 놓인 줄을 따름
const KIND_BG: Record<CallKind, string> = {
  accept: 'bg-kind-accept',
  lookup: 'bg-kind-lookup',
  cancel: 'bg-kind-cancel',
  faq: 'bg-kind-faq',
}

export function KindChips({ kinds }: { kinds: { kind: CallKind; label: string }[] }) {
  return kinds.map((k) => (
    <span
      key={k.kind}
      className={`grid h-7 min-w-19 shrink-0 place-items-center px-3 ${KIND_BG[k.kind]}`}
    >
      {k.label}
    </span>
  ))
}
