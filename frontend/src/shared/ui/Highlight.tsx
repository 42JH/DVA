import type { ReactNode } from 'react'
import { findKo } from '@/shared/lib/search'

// 검색어 하이라이트 (09 FAQ 검색, 11/04 사용자) — 검색과 같은 규칙(띄어쓰기 · 대소문자 무시 · 초성)으로 맞은 자리만 옅은 파랑 바탕
// 마크다운 답변은 Markdown highlight= 로 (같은 MARK)
export const MARK = 'rounded-sm bg-brand/20 text-inherit'

export function Highlight({ text, q }: { text: string; q?: string }) {
  const hits = q ? findKo(text, q) : []
  if (!hits.length) return text
  const out: ReactNode[] = []
  let at = 0
  for (const [s, e] of hits) {
    out.push(
      text.slice(at, s),
      <mark key={s} className={MARK}>
        {text.slice(s, e)}
      </mark>,
    )
    at = e
  }
  out.push(text.slice(at))
  return out
}
