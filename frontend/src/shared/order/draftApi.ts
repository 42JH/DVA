// 배송 초안 상세 (백엔드 055) — 주문 상세 쿼리(orderApi, 음수 번호)가 씀. 목록 · 접수 · 삭제는 features/order/api/draftApi
// 초안을 '음수 번호 주문'(-draftSeq)으로 바꿔 주문 상세 패널 · 빈 칸 채우기를 그대로 씀
import { api, type ApiItem } from '@/shared/api/client'
import { countsOf, type KindCountsDto } from '@/shared/lib/callKind'
import { toOrderDetail, type OrderAddressDto, type OrderDetailDto } from './orderDto'
import { orderNo } from './labels'
import type { OrderDetail } from './orderApi'

export interface ParcelDraftDto {
  draftSeq: number
  callSessionSeq: number | null
  customerSeq: number | null
  callerPhoneNumber: string | null // 처음 건 번호 사본
  status: 'READY' | 'EDITING' | 'INCOMPLETE' | 'CONVERTED' | 'CANCELLED' | 'RESUMED'
  version: number
  legacyOrderSeq: number | null // 055 이관 전 미완료 주문 번호 (통화 목록에 남아 있는 번호)
  createdAt: string
  parcel: {
    origin: OrderAddressDto
    destination: OrderAddressDto
    documentCount: number
    smallBoxCount: number
    mediumBoxCount: number
    bigBoxCount: number
    otherItemDescription: string
    clientComment: string
    notifiedPrice: number | null
    itemPrice: number | null
  }
}

/** 화면 번호 — 이관된 건은 옛 주문번호(통화 목록과 같은 번호), 새 건은 '미완료 n' */
export const draftLabel = (d: Pick<ParcelDraftDto, 'draftSeq' | 'legacyOrderSeq'>) =>
  d.legacyOrderSeq ? orderNo(d.legacyOrderSeq) : `미완료 ${d.draftSeq}`

/** 초안 상세 → 주문 상세 모양 (상태 COLLECTING · 결제 방식 미정) + 그 통화 */
export async function fetchDraft(draftSeq: number, signal?: AbortSignal): Promise<OrderDetail> {
  const { data: d } = await api.get<ApiItem<ParcelDraftDto>>(`/parcel-drafts/${draftSeq}`, {
    signal,
  })
  const asOrder: OrderDetailDto = {
    orderSeq: -d.draftSeq,
    customerSeq: d.customerSeq,
    status: 'COLLECTING',
    paymentMethodType: null,
    creationSource: d.callSessionSeq ? 'AI' : 'ADMIN',
    pickupRequestedAt: null,
    createdAt: d.createdAt,
    paymentDueAt: null,
    paidAt: null,
    totalAmount: null,
    billingOrganizationSeq: null,
    billingOrganizationName: null,
    billingDepartmentSeq: null,
    billingDepartmentName: null,
    paymentRequest: null,
    version: d.version,
    parcelNo: null,
    dverReceivedAt: null,
    updatedAt: d.createdAt,
    parcels: [
      {
        ...d.parcel,
        originPin: null,
        status: 'ACTIVE',
        orderParcelSeq: -d.draftSeq,
        orderSeq: -d.draftSeq,
        parcelPosition: 1,
      },
    ],
  }
  // 이 초안이 나온 통화 (없거나 지워졌으면 비움 — 초안은 그대로 보임)
  const call = d.callSessionSeq
    ? await api
        .get<ApiItem<{ call: { startedAt: string | null }; analysis: KindCountsDto | null }>>(
          `/calls/${d.callSessionSeq}`,
          { signal },
        )
        .then((r) => r.data)
        .catch(() => null)
    : null
  return {
    ...toOrderDetail(asOrder),
    relatedCalls:
      d.callSessionSeq && call?.call.startedAt
        ? [
            {
              callSessionSeq: d.callSessionSeq,
              startedAt: call.call.startedAt,
              kind: 'ACCEPT',
              counts: countsOf(call.analysis),
            },
          ]
        : [],
    draft: { draftSeq: d.draftSeq, label: draftLabel(d) },
  }
}
