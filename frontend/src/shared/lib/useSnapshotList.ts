// 실시간 목록 (주문 · 통화) — 쪽 번호 + 기준 시각
// 통화 · 주문은 보는 중에도 계속 들어옴 → 쪽을 offset으로만 자르면 새 항목만큼 줄이 밀려 같은 줄이 두 번 보이거나 빠짐.
// 그래서 처음 연 순간의 '가장 최근 항목 시각'을 기준(at)으로 정하고, 모든 쪽 · 총 건수를 '기준 이전' 항목에서만 셈 → 쪽을 넘겨도 밀리지 않음.
// 기준은 주소에 남겨 새로고침 · 뒤로 가기 · 링크 공유에도 같은 목록. 기준 이후 들어온 것은 15초마다 세어 [새 N건 · 최신 목록 보기]로만 알림
// 서버 시각 범위: from 포함 · to 미포함. 기준 = 최신 항목 시각 + 1ms (내 컴퓨터 시계가 틀려도 서버 시각 기준)
// ponytail: 기준 이전 항목의 상태가 바뀌어 상태 탭에서 빠지면(결제 대기 → 결제 완료) 그 탭의 뒤쪽 줄이 한 칸 당겨짐 — 탭을 다시 누르면 맞음
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api, type ApiList } from '@/shared/api/client'
import { oldestPage, usePageSize } from './paging'

type Q = Record<string, string | number | undefined>
const iso = (ms: number) => new Date(ms).toISOString()

export function useSnapshotList<T>({
  key,
  path,
  query,
  at,
  page,
  asOf,
  go,
  asc = false,
  enabled: on = true,
  anchorQuery = query,
}: {
  key: string // 쿼리 키 이름 ('orders' · 'calls')
  path: string // GET 경로 (최신순)
  query: Q // 검색 · 상태 · 기간
  at: (x: T) => string | null // 정렬 시각 (서버 to가 거르는 칸)
  page: number // 주소의 쪽
  asOf: string // 주소의 기준 시각(ms) — 비면 지금 최신
  go: (p: { page: number; at?: string }) => void // 주소 바꾸기
  asc?: boolean // 오래된 순
  // 기준 시각을 정할 조건 — 주문처럼 상태 탭마다 건수를 같이 보이면 탭 조건을 뺀 것을 줌 (탭마다 기준이 달라 건수가 흔들리지 않게)
  anchorQuery?: Q
  enabled?: boolean // false면 목록 · 건수 · 새 건수를 안 받음(기준 시각만) — 주문 미완료 탭(초안 목록)일 때
}) {
  const [size, setSize] = usePageSize()
  const qc = useQueryClient()
  const get = (q: Q, signal: AbortSignal) => api.get<ApiList<T>>(path, { query: q, signal })

  // 기준 시각 정하기 — 주소에 없으면 최신 1건을 받아 그 시각 + 1ms
  const anchorKey = ['screen', key, 'anchor', anchorQuery] as const
  const anchor = useQuery({
    queryKey: anchorKey,
    enabled: !asOf,
    staleTime: Infinity, // 저절로 바뀌지 않게 — [최신 목록 보기]를 눌러야
    queryFn: ({ signal }) =>
      get({ ...anchorQuery, limit: 1, offset: 0 }, signal).then((r) => {
        const ms = Date.parse(r.data[0] ? (at(r.data[0]) ?? '') : '')
        return (Number.isNaN(ms) ? Date.now() : ms) + 1
      }),
  })
  const to = Number(asOf) || anchor.data

  // 오래된 순: 서버는 최신순만 줌 → 기준 이전 총 건수로 뒤쪽부터 잘라 받아 뒤집음
  const count = useQuery({
    queryKey: ['screen', key, 'count', query, to],
    enabled: on && asc && to !== undefined,
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      get({ ...query, to: iso(to!), limit: 1, offset: 0 }, signal).then((r) => r.total_count),
  })
  const n = count.data ?? 0
  const opts = (p: number) => ({
    queryKey: ['screen', key, query, to, size, p, asc ? n : 'desc'] as const,
    enabled: on && to !== undefined && (!asc || count.data !== undefined),
    staleTime: Infinity,
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const page = (limit: number, offset: number) =>
        get({ ...query, to: iso(to!), limit, offset }, signal)
      return asc ? oldestPage(n, p, size, page) : page(size, (p - 1) * size)
    },
  })
  const list = useQuery({ ...opts(page), placeholderData: keepPreviousData })
  const total = list.data?.total_count ?? 0
  const pages = Math.max(1, Math.ceil(total / size))

  // 없는 쪽(주소를 직접 고침 · 다른 사람이 지움)이면 마지막 쪽으로
  useEffect(() => {
    if (on && list.data && !list.isPlaceholderData && total > 0 && page > pages) go({ page: pages })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 받은 결과가 바뀔 때만
  }, [list.data, page, pages])

  // 다음 쪽을 미리 받아 둠 — 넘기며 훑는 운영 업무
  useEffect(() => {
    if (on && list.data && !list.isPlaceholderData && page < pages)
      void qc.prefetchQuery(opts(page + 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 쪽 · 기준이 바뀔 때만
  }, [list.data, page, pages])

  // 기준 이후 새로 들어온 수 — 15초마다
  const fresh = useQuery({
    queryKey: ['screen', key, 'fresh', query, to],
    enabled: on && to !== undefined,
    refetchInterval: 15_000,
    queryFn: ({ signal }) =>
      get({ ...query, from: iso(to!), limit: 1, offset: 0 }, signal).then((r) => r.total_count),
  })

  const stuck = (!asOf && !!anchor.error) || (on && asc && !!count.error)
  return {
    items: list.data?.data ?? [],
    // 기준 시각 · 건수가 실패하면 목록은 영영 안 불림 → 그것도 실패로 (11/09 검수: 뼈대만 계속 보이던 것)
    // 지금 쓰는 쪽의 실패만 — 꺼진 조회에 남은 옛 실패는 안 봄
    isLoading: list.isPending && !stuck,
    isStale: list.isPlaceholderData,
    error: list.error || stuck ? '불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' : null,
    total,
    page: Math.min(page, pages),
    size,
    setSize,
    asOf: to, // 상태 탭 건수도 같은 기준으로 세라고
    // 쪽을 넘기면 기준을 주소에 고정
    setPage: (p: number) => go({ page: p, at: to ? String(to) : '' }),
    fresh: fresh.data ?? 0,
    latest: () => {
      go({ page: 1, at: '' })
      void qc.resetQueries({ queryKey: anchorKey })
    },
  }
}
