import { useEffect, useState } from 'react'

/** 값이 ms 동안 그대로일 때만 바뀌는 값 — 검색칸에 칠 때마다 서버에 묻지 않게 (입력칸 자체는 바로 바뀜) */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}
