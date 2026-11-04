import { useEffect, useState, type KeyboardEvent } from 'react'

// 치는 대로 검색 (04 통화 · 03 주문, 11/04 사용자) — 창 없이 칸에 바로 침, 아래 목록이 바로 바뀜
// 0.25초 멈추면 적용(칠 때마다 요청하지 않게) · Enter는 바로 · Esc · ✕는 지움
// 끝에 덜 친 자모('김ㅁ')는 떼고 보냄 — 치는 도중 목록이 비었다 차지 않게
const clean = (v: string) => v.trim().replace(/[ㄱ-ㅎㅏ-ㅣ]+$/, '')

export function useLiveSearch(q: string, onSearch: (q: string) => void) {
  const [text, setText] = useState(q)
  useEffect(() => {
    const t = setTimeout(() => onSearch(clean(text)), 250)
    return () => clearTimeout(t)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps -- 친 글이 바뀔 때만 (onSearch는 렌더마다 새 함수)
  const clear = () => {
    setText('')
    onSearch('')
  }
  return {
    text,
    setText,
    clear,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing) return // 한글 조합을 끝내는 Enter
      if (e.key === 'Enter') onSearch(clean(text))
      else if (e.key === 'Escape') clear()
    },
  }
}
