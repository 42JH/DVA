import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

/**
 * 목록 화면의 필터 · 쪽 번호를 URL 쿼리에 두는 훅 (03 · 04 · 05 · 09 공통)
 * 왜: 상세로 갔다가 뒤로가기 하면 보던 필터 · 쪽이 그대로여야 하고(‹ 목록으로 버튼을 뺀 대신), 주소를 복사해 공유할 수 있어야 함
 * 사용법:
 *   const DEFAULTS = { q: '', date: 'today', kind: 'all' } as const   // 모듈 상수로 (렌더마다 새 객체면 안 됨)
 *   const { params, page, set, reset, isDefault } = useListParams(DEFAULTS)
 *   set({ kind: 'edit' })   // 필터를 바꾸면 쪽은 1로 돌아감
 *   set({ page: 3 })        // 쪽만 바꿈
 *   isDefault               // 전부 기본값이면 '적용된 필터' 줄을 숨김
 * 규칙: 기본값과 같은 키는 URL에서 지움(주소가 깨끗하게), 쪽 1도 지움. 주소 변경은 replace라 뒤로가기가 글자 하나하나를 거치지 않음
 */
export function useListParams<T extends Record<string, string>>(defaults: T) {
  const [sp, setSp] = useSearchParams()

  const params = useMemo(() => {
    const out = { ...defaults }
    for (const k of Object.keys(defaults) as (keyof T)[]) {
      const v = sp.get(k as string)
      if (v !== null) out[k] = v as T[keyof T]
    }
    return out
  }, [sp, defaults])

  const page = Math.max(1, Math.floor(Number(sp.get('page')) || 1))

  const set = useCallback(
    (patch: Partial<T> & { page?: number }) => {
      setSp(
        (prev) => {
          const next = new URLSearchParams(prev)
          let filterChanged = false
          for (const [k, v] of Object.entries(patch)) {
            if (k === 'page') continue
            filterChanged = true
            if (v === undefined || v === defaults[k]) next.delete(k)
            else next.set(k, String(v))
          }
          const p = patch.page ?? (filterChanged ? 1 : page)
          if (p <= 1) next.delete('page')
          else next.set('page', String(p))
          return next
        },
        // flushSync: 라우터는 기본으로 주소 변경을 startTransition으로 늦게 반영 → 검색칸처럼 값이 주소에서 오는 입력은
        // 칠 때마다 이전 값으로 되돌아갔다가 다시 바뀌어 한글 조합이 깨지고 커서가 끝으로 튐. 바로 반영해서 막음
        { replace: true, flushSync: true },
      )
    },
    [setSp, defaults, page],
  )

  const reset = useCallback(() => setSp({}, { replace: true }), [setSp])
  const isDefault =
    page === 1 && (Object.keys(defaults) as (keyof T)[]).every((k) => params[k] === defaults[k])

  return { params, page, set, reset, isDefault }
}
