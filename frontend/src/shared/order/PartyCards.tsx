import type { ReactNode } from 'react'

// 보내는 분 ≫ 받는 분 (주문 상세 · 추가 · 수정 창, 11/04) — 하늘색 카드(틀 색) 두 장 사이에 파랑 ≫ (03 목록 검색칸 사이와 같은 표시)

export function PartyPair({ sender, receiver }: { sender: ReactNode; receiver: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2">
      {sender}
      <svg
        viewBox="0 0 40 40"
        className="size-8 self-center text-brand"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M10 28.33 18.33 20 10 11.67M21.67 28.33 30 20l-8.33-8.33" />
      </svg>
      {receiver}
    </div>
  )
}

/** 카드 하나 — 제목(파랑 14/600) + 내용 */
export function PartyCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl bg-frame px-6 py-5">
      <h3 className="text-label font-semibold text-brand">{title}</h3>
      {children}
    </section>
  )
}
