import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { todayYmd, type Ymd } from './dateRange'

// 날짜별 무한 목록 (04 통화 · 03 주문, Figma 11/04) — 고른 날(anchor, 기본 오늘)부터 하루씩 받음
// 아래로 = 더 지난 날, 위로 = 다음 날 — 둘 다 건이 있는 날로 건너뜀(위로는 오늘까지). 오늘은 5초마다 새로
// 고른 날에 건이 없어도 그 날이 첫 쪽(빈 쪽) — 화면은 그 자리를 남겨 머리 날짜가 고른 날로 보이게 함 (11/04 사용자: 빈 날을 골라도 이동)
// 화면은 shared/ui/DayScroll이 그림 (끝에 닿으면 loadOlder · loadNewer)

/** 오늘 목록 갱신 주기 — 새 건 · 늦은 분석이 보이게 (11/02 연동 명세). 숨긴 탭에선 멈춤 */
const LIVE_MS = 5_000

type DayParam = { day: Ymd } | { before: Ymd } | { after: Ymd }
/** 한 쪽 = 하루. day null = 더 지난 건 없음 */
interface DayPage<T> {
  day: Ymd | null
  rows: T[]
}

export interface DaySource<T> {
  key: readonly unknown[] // 목록 뿌리 (예: ['calls', 'list']) — 무효화는 이 키로
  filter: unknown // 서버 조건(검색어 · 상태). 바뀌면 새 목록 — 같은 날이면 새 결과가 올 때까지 이전 목록을 흐리게 둠
  anchor: Ymd
  fetchDay: (day: Ymd, signal: AbortSignal) => Promise<T[]> // 그날 전부 (최신순)
  prevDay: (before: Ymd, signal: AbortSignal) => Promise<Ymd | null> // before 전에 건이 있는 가장 가까운 날
  nextDay: (after: Ymd, signal: AbortSignal) => Promise<Ymd | null> // after 다음에 건이 있는 가장 가까운 날 (없으면 null)
}

/** DayScroll이 그리는 모양 — 화면은 rows만 화면용으로 바꿔 넘김 */
export interface DayFeed<R> {
  anchor: Ymd // 고른 날 — 건이 없어도 화면이 그 자리를 남김
  days: { day: Ymd; rows: R[] }[]
  isLoading: boolean
  stale: boolean // 조건을 바꿔 새 결과를 받는 중 (이전 목록을 흐리게)
  error: string | null
  notice: string | null
  hasNewer: boolean
  hasOlder: boolean
  loadingNewer: boolean
  loadingOlder: boolean
  newerError: boolean
  olderError: boolean
  busy: boolean // 받는 중(어느 쪽이든) — 끝나면 화면이 끝에 닿아 있는지 다시 봄
  loadNewer: () => void
  loadOlder: () => void
}

export function useDayFeed<T>({
  key,
  filter,
  anchor,
  fetchDay,
  prevDay,
  nextDay,
}: DaySource<T>): DayFeed<T> {
  const today = todayYmd()
  const list = useInfiniteQuery({
    queryKey: [...key, 'days', anchor, filter],
    initialPageParam: { day: anchor } as DayParam,
    queryFn: async ({ pageParam, signal }): Promise<DayPage<T>> => {
      const day =
        'day' in pageParam
          ? pageParam.day
          : 'after' in pageParam
            ? // 다음 날도 빈 날은 건너뜀(하루씩 묻지 않게). 오늘까지 없으면 오늘(빈 쪽) — 새 건이 오면 보이게
              ((await nextDay(pageParam.after, signal)) ?? today)
            : await prevDay(pageParam.before, signal)
      return { day, rows: day ? await fetchDay(day, signal) : [] }
    },
    getNextPageParam: (last): DayParam | undefined => (last.day ? { before: last.day } : undefined),
    getPreviousPageParam: (first): DayParam | undefined =>
      first.day && first.day < todayYmd() ? { after: first.day } : undefined,
    staleTime: 5 * 60_000, // 지난 날은 안 바뀜. 오늘은 아래 live가 따로 갱신
    // 조건만 바뀌면(같은 날) 새 결과가 올 때까지 이전 목록을 그대로 — 칠 때마다 목록이 비었다 차지 않게
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[key.length + 1] === anchor ? prev : undefined,
  })
  const pages = list.data?.pages ?? []
  // 오늘 — 5초마다 (목록에 오늘이 있을 때만). 받으면 무한 목록의 오늘 쪽을 이걸로 바꿔 그림
  const live = useQuery({
    queryKey: [...key, 'today', filter],
    queryFn: ({ signal }) => fetchDay(today, signal),
    refetchInterval: LIVE_MS,
    refetchOnWindowFocus: 'always', // 탭에 돌아오면 바로 (명세: 복귀 시 다시 조회)
    enabled: pages[0]?.day === today,
  })

  return {
    anchor,
    days: pages.flatMap((p) =>
      p.day ? [{ day: p.day, rows: p.day === today && live.data ? live.data : p.rows }] : [],
    ),
    isLoading: list.isPending,
    stale: list.isPlaceholderData,
    error: list.isError && !pages.length ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,
    // 받아 둔 줄은 그대로 두고 알림 (11/02 연동 명세)
    notice:
      live.isError && !!live.data
        ? '오늘 목록을 다시 받지 못했어요. 마지막으로 받은 목록이에요.'
        : null,
    hasNewer: list.hasPreviousPage,
    hasOlder: list.hasNextPage,
    loadingNewer: list.isFetchingPreviousPage,
    loadingOlder: list.isFetchingNextPage,
    newerError: list.isFetchPreviousPageError,
    olderError: list.isFetchNextPageError,
    busy: list.isFetching,
    // 한 번에 한 방향만 (서로 끊지 않게) — 스크롤 끝에 닿을 때 화면이 부름
    loadNewer: () => {
      if (!list.isFetching) void list.fetchPreviousPage({ cancelRefetch: false })
    },
    loadOlder: () => {
      if (!list.isFetching) void list.fetchNextPage({ cancelRefetch: false })
    },
  }
}
