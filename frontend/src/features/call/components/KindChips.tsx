import type { CallKind } from '@/features/call/api/callDto'

// 상담 유형 칩 (Figma '통화' 11/04 — 04 줄 · 06 머리) — 높이 28 · 폭 76(숫자가 붙어도 같은 폭) · 바탕색만
// 11/05 사용자 이미지: 둥근 알약 · 글자 16 (줄 글자 20보다 작게)
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
      className={`grid h-7 min-w-19 shrink-0 place-items-center rounded-full px-3 text-body ${KIND_BG[k.kind]}`}
    >
      {k.label}
    </span>
  ))
}
