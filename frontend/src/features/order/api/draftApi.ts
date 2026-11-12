// 배송 초안 (백엔드 055 · parcel-draft-frontend-integration.md) — 미완료는 이제 주문이 아니라 초안(INCOMPLETE)
// 화면은 초안을 '음수 번호 주문'(-draftSeq)으로 다룸 → 주문 상세 패널 · 빈 칸 채우기 · 목록 줄을 그대로 씀
// 접수 = 원본으로 새 초안을 READY로 만들고(POST) 바로 최종 접수(submit). 원본은 서버가 RESUMED로 바꿔 미완료에서 빠짐
// 삭제 = 서버 숨김(soft delete, 5년 보관). 실제 주문 · 결제와 무관
import { api, ApiError, type ApiItem, type ApiList } from '@/shared/api/client'
import { draftLabel, type ParcelDraftDto } from '@/shared/order/draftApi'
import { orderNo } from '@/shared/order/labels'
import type { OrderDetail, Party } from '@/shared/order/orderApi'
import type { OrderInput, OrderListItem, PartyInput } from './orderApi'

/** 목록 한 줄 — 주문 목록 줄과 같은 모양 (orderSeq = -draftSeq) */
export const draftListItem = (d: ParcelDraftDto): OrderListItem & { label: string } => ({
  orderSeq: -d.draftSeq,
  label: draftLabel(d),
  status: 'COLLECTING',
  createdAt: d.createdAt,
  pickupRequestedAt: null,
  parcels: [{ ...d.parcel, orderParcelSeq: -d.draftSeq, status: 'ACTIVE' }],
})

/** 관리자 주문 목록에 섞여 온 초안 줄 → 초안 목록 줄과 같은 모양 (-draftSeq). orderSeq(예약번호)는 실제 주문 상세에 쓰면 안 됨 */
export const fromAdminList = (o: OrderListItem): OrderListItem & { label?: string } =>
  o.draftSeq == null
    ? o
    : {
        ...o,
        orderSeq: -o.draftSeq,
        label: orderNo(o.orderSeq),
        parcels: o.parcels.map((p) => ({ ...p, orderParcelSeq: -o.draftSeq! })),
      }

export const draftList = (q: { q?: string; limit: number; offset: number }, signal?: AbortSignal) =>
  api.get<ApiList<ParcelDraftDto>>('/parcel-drafts', {
    query: { ...q, status: 'INCOMPLETE' },
    signal,
  })

export const deleteDraft = (draftSeq: number) =>
  api.delete('/parcel-drafts', { body: { draftSeqs: [draftSeq] } })

const METHOD = { PERSONAL_CARD: 'billing', MONTHLY: 'credit', GROUP_CARD: 'groupBilling' } as const

/** 주소 — 새로 검색했으면 고른 값, 아니면 초안에 있던 지번 · 동 · 우편번호 그대로 */
const address = (p: PartyInput, was: Party) => ({
  name: p.name,
  phoneNumber: p.phoneNumber,
  roadAddress: p.roadAddress,
  detailAddress: p.detailAddress ?? '',
  jibunAddress: p.picked?.jibunAddress ?? was.jibunAddress ?? '',
  dongName: p.picked?.dongName ?? was.dongName ?? '',
  postalCode: p.picked?.postalCode ?? was.postalCode ?? '',
})

/** 고객이 없는 초안 — 보내는 분 전화번호로 찾고, 없으면 등록 (수기 주문과 같은 규칙: 주문자 = 보내는 분) */
async function customerFor(sender: ReturnType<typeof address>): Promise<number> {
  const find = () =>
    api
      .post<ApiItem<{ customer: { customerSeq: number } | null }>>('/customers/context', {
        body: { phoneNumber: sender.phoneNumber },
      })
      .then((r) => r.data.customer?.customerSeq ?? null)
  const found = await find()
  if (found) return found
  try {
    const { name, phoneNumber, ...addr } = sender
    const r = await api.post<ApiItem<{ customerSeq: number }>>('/customers', {
      body: { name, phoneNumber, address: addr },
    })
    return r.data.customerSeq
  } catch (e) {
    // 그 사이 같은 번호가 등록됨 → 다시 찾음
    if (e instanceof ApiError && e.code === 'DUPLICATE_RESOURCE') {
      const again = await find()
      if (again) return again
    }
    throw e
  }
}

/** 빈 칸을 채워 접수 — 새 READY 초안(같은 clientParcelId면 서버가 같은 초안을 돌려줌) → 최종 접수. 응답 status만 결과로 */
export async function submitDraft(
  order: OrderDetail,
  input: OrderInput,
  shippingFee: number,
  clientParcelId: string,
): Promise<{ status: string; orderSeq: number }> {
  const origin = address(input.sender, order.sender)
  const destination = address(input.receiver, order.receiver)
  // 원본에 고객이 있으면 그 고객 그대로(바꿀 수 없음), 없으면 관리자가 정해 보냄
  const customerSeq = order.customerSeq ? null : await customerFor(origin)
  const created = await api.post<ApiItem<ParcelDraftDto>>('/parcel-drafts', {
    body: {
      clientParcelId,
      sourceDraftSeq: order.draft!.draftSeq,
      status: 'READY',
      ...(customerSeq ? { customerSeq } : {}),
      parcel: {
        origin,
        destination,
        documentCount: input.items.document,
        smallBoxCount: input.items.small,
        mediumBoxCount: input.items.medium,
        bigBoxCount: input.items.big,
        otherItemDescription: input.items.other ?? '',
        clientComment: input.request ?? '',
        itemPrice: input.declaredValue,
        notifiedPrice: shippingFee,
      },
    },
  })
  const method =
    input.paymentMethod && input.paymentMethod !== 'BRANCH_VISIT'
      ? METHOD[input.paymentMethod]
      : null
  const r = await api.post<ApiItem<{ status: string; orderSeq: number }>>(
    `/admin/parcel-drafts/${created.data.draftSeq}/submit`,
    {
      body: {
        expectedVersion: created.data.version,
        ...(method ? { paymentMethodType: method } : {}),
        ...(input.pickupAt ? { pickupRequestedAt: input.pickupAt } : {}),
      },
    },
  )
  return r.data
}
