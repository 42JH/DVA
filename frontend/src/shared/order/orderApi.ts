// 주문 상세 — 03 주문 내역(팀원) · 06 통화 상세 '주문 보기'가 같이 씀 (공통으로 올림, shared/auth와 같은 예외)
// GET /orders/{id} (연동 상세명세 10/31 §4.2) → orderDto.toOrderDetail, 관련 통화는 GET /calls?orderSeq (§2 03_주문상세_전화)
// api 역할: React를 모른다. 화면용 값은 useOrderDetail.ts
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import { toOrderDetail, type OrderDetailDto } from './orderDto'
import { countsOf, type KindCountsDto } from '@/shared/lib/callKind'
import { fetchDraft } from './draftApi'
import type { OrderDetail } from './orderTypes'

export type { OrderDetail, Party, PaymentMethod, PaymentState } from './orderTypes'

export const orderQueries = {
  all: () => ['orders'] as const,
  detail: (id: number) =>
    queryOptions({
      queryKey: [...orderQueries.all(), id],
      queryFn: ({ signal }) => (id < 0 ? fetchDraft(-id, signal) : fetchOrder(id, signal)), // 음수 = 배송 초안
    }),
}

/** 통화 목록 줄 중 관련 통화에 필요한 칸만 (CallListItem §13) */
interface RelatedCallDto {
  callSessionSeq: number
  startedAt: string | null
  analysis: KindCountsDto | null // 접수 · 취소 건수로 종류를 가름
}

async function fetchOrder(id: number, signal?: AbortSignal): Promise<OrderDetail> {
  const [res, calls] = await Promise.all([
    api.get<ApiItem<OrderDetailDto>>(`/orders/${id}`, { signal }),
    fetchAll<RelatedCallDto>('/calls', { orderSeq: id }, signal), // 응답에 관련 통화가 없어 통화 목록에서
  ])
  return {
    ...toOrderDetail(res.data),
    relatedCalls: calls
      .filter((c): c is RelatedCallDto & { startedAt: string } => c.startedAt !== null)
      .map((c) => ({
        callSessionSeq: c.callSessionSeq,
        startedAt: c.startedAt,
        kind:
          !!c.analysis?.cancelledParcelCount && !c.analysis.registeredParcelCount
            ? ('CANCEL' as const)
            : ('ACCEPT' as const),
        counts: countsOf(c.analysis),
      }))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
  }
}
