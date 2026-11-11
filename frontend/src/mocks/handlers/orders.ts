import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { allOrders, type OrderDetail } from '@/shared/order/orderApi'
import type {
  OrderAddressDto,
  OrderDetailDto,
  OrderStatusDto,
  PaymentMethodDto,
} from '@/shared/order/orderDto'

// 가짜 주문 상세 GET /orders/{id} (연동 상세명세 10/31 §4.2) · 목록 GET /admin/orders (§4.1) — 모양 그대로
// 데이터는 shared/order/orderApi.ts의 메모리 저장소(03 주문 내역 가짜 목록 · 추가 · 수정이 쓰는 것)를 그대로 읽어 DTO로 바꿈
//   → 03에서 추가한 주문도 06 '주문 보기' 팝업에서 같은 내용으로 보임. 화면 → DTO 변환은 orderDto.toOrderDetail의 반대
const METHOD: Record<NonNullable<OrderDetail['paymentMethod']>, PaymentMethodDto> = {
  MONTHLY: 'credit',
  GROUP_CARD: 'groupBilling',
  PERSONAL_CARD: 'billing',
  BRANCH_VISIT: 'cat',
}
const STATUS: Record<OrderDetail['paymentState'], OrderStatusDto> = {
  PAID: 'ACCEPTED',
  UNPAID: 'notPaid',
  CANCELLED_BEFORE_PAYMENT: 'CANCELLED',
}
/** 목록 칩을 다 볼 수 있게 결제 완료 몇 건을 번호로 미완료 · 접수 실패 · 결제 완료(디버 전)로 섞음 (상세도 같은 상태) */
const statusOf = (o: OrderDetail): OrderStatusDto =>
  o.cancelled
    ? 'CANCELLED'
    : o.paymentState !== 'PAID'
      ? STATUS[o.paymentState]
      : o.orderSeq % 11 === 4
        ? 'COLLECTING'
        : o.orderSeq % 13 === 5
          ? 'SUBMISSION_FAILED'
          : o.orderSeq % 5 === 2
            ? 'PAID'
            : 'ACCEPTED'
const address = (p: OrderDetail['sender']) => ({
  name: p.name || null,
  phoneNumber: p.phoneNumber || null,
  roadAddress: p.roadAddress || null,
  jibunAddress: null,
  detailAddress: p.detailAddress,
  dongName: null,
  postalCode: null,
})

/** 화면 주문 → 서버 DTO (상세 parcel 하나짜리) */
function toDto(o: OrderDetail): OrderDetailDto {
  return {
    orderSeq: o.orderSeq,
    customerSeq: null,
    status: statusOf(o),
    paymentMethodType: o.paymentMethod ? METHOD[o.paymentMethod] : null,
    creationSource: o.route === 'MANUAL' ? 'ADMIN' : 'AI',
    pickupRequestedAt: o.pickupRequestedAt ? new Date(o.pickupRequestedAt).toISOString() : null,
    createdAt: new Date(o.acceptedAt).toISOString(),
    paymentDueAt: null,
    paidAt: o.paymentState === 'PAID' ? new Date(o.acceptedAt).toISOString() : null,
    totalAmount: null,
    billingOrganizationSeq: null,
    billingOrganizationName: null,
    billingDepartmentSeq: null,
    billingDepartmentName: null,
    paymentRequest: null,
    version: 1,
    parcelNo: null,
    dverReceivedAt: null,
    updatedAt: new Date(o.acceptedAt).toISOString(),
    parcels: [
      {
        status: o.cancelled ? 'CANCELLED' : 'ACTIVE',
        orderParcelSeq: o.orderSeq * 10 + 1,
        orderSeq: o.orderSeq,
        parcelPosition: 1,
        origin: address(o.sender),
        destination: address(o.receiver),
        originPin: null,
        documentCount: o.items.document,
        smallBoxCount: o.items.small,
        mediumBoxCount: o.items.medium,
        bigBoxCount: o.items.big,
        otherItemDescription: o.items.other ?? '',
        clientComment: o.clientComment ?? '',
        notifiedPrice: null,
        itemPrice: o.itemPrice,
      },
    ],
  }
}

/** 목록 한 건 (AdminOrderListItem) — 상세 하나짜리 */
function toListItem(o: OrderDetail) {
  const { parcels, ...dto } = toDto(o)
  const party = ({
    name,
    phoneNumber,
    roadAddress,
    jibunAddress,
    detailAddress,
  }: OrderAddressDto) => ({
    name,
    phoneNumber,
    roadAddress,
    jibunAddress,
    detailAddress,
  })
  return {
    orderSeq: dto.orderSeq,
    status: dto.status,
    createdAt: dto.createdAt,
    pickupRequestedAt: dto.pickupRequestedAt,
    parcels: parcels.map((p) => ({
      ...p,
      origin: party(p.origin),
      destination: party(p.destination),
    })),
  }
}

// 서버 statusGroup 규칙 (admin-order-list.dto, 11/11): 결제 완료 = PAID · SUBMITTING · 재시도 중 실패, 접수 완료 = ACCEPTED, 접수 실패 = 최종 실패만
const GROUP: Record<string, OrderStatusDto[]> = {
  PAID: ['PAID', 'SUBMITTING', 'SUBMITTING_FAILED'],
}

// ---------- 배송 초안 (055) — 가짜 미완료 주문을 초안으로 (draftSeq = 옛 주문번호, legacyOrderSeq도 같음) ----------
const draftGone = new Set<number>() // 삭제 · 재개(RESUMED)된 원본
const madeDrafts = new Map<string, ReturnType<typeof draftOf>>() // clientParcelId → 새 초안 (같은 키면 같은 초안)
let nextDraft = 90000
const found = (road: string | null) =>
  road ? { jibunAddress: road, dongName: '가짜동', postalCode: '04000' } : {}
function draftOf(o: OrderDetail) {
  const p = toDto(o).parcels[0]
  return {
    draftSeq: o.orderSeq,
    callSessionSeq: null as number | null,
    customerSeq: o.orderSeq % 3 === 0 ? null : o.orderSeq, // 3건에 1건은 고객 없음
    createdByAdminUserSeq: null,
    callerPhoneNumber: o.sender.phoneNumber || null,
    clientParcelId: `legacy-${o.orderSeq}`,
    // 빈 칸이 있는 초안처럼 — 물품 가액 · 받는 분 전화를 비움. 주소는 AI가 검색해 둔 것처럼 지번 · 동 · 우편번호까지
    parcel: {
      ...p,
      itemPrice: null,
      origin: { ...p.origin, ...found(p.origin.roadAddress) },
      destination: { ...p.destination, ...found(p.destination.roadAddress), phoneNumber: null },
    },
    status: 'INCOMPLETE' as string,
    version: 1,
    intakeVersion: null,
    sourceDraftSeq: null as number | null,
    orderSeq: null as number | null,
    orderParcelSeq: null,
    legacyOrderSeq: o.orderSeq as number | null,
    reservedOrderSeq: 20000 + o.orderSeq, // 057 · 058 예약 주문번호 (058은 옛 초안에도 새 번호)
    legacyOrderParcelSeq: o.orderSeq * 10 + 1,
    createdAt: new Date(o.acceptedAt).toISOString(),
    updatedAt: new Date(o.acceptedAt).toISOString(),
    retentionStartedAt: new Date(o.acceptedAt).toISOString(),
  }
}
const openDrafts = () =>
  allOrders()
    .filter((o) => statusOf(o) === 'COLLECTING' && !draftGone.has(o.orderSeq))
    .map(draftOf)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
const draftById = (id: number) =>
  openDrafts().find((d) => d.draftSeq === id) ??
  [...madeDrafts.values()].find((d) => d.draftSeq === id)
const meta = () => ({ requestId: crypto.randomUUID() })

const draftHandlers = [
  http.get(`${API_BASE_URL}/parcel-drafts`, ({ request }) => {
    const u = new URL(request.url).searchParams
    const q = u.get('q')?.toLowerCase()
    const limit = Number(u.get('limit') ?? 20)
    const offset = Number(u.get('offset') ?? 0)
    const rows = openDrafts().filter(
      (d) =>
        !q ||
        [d.parcel.origin, d.parcel.destination].some((x) =>
          Object.values(x).some((v) => v?.toLowerCase().includes(q)),
        ),
    )
    return HttpResponse.json({
      data: rows.slice(offset, offset + limit),
      hasNext: offset + limit < rows.length,
      total_count: rows.length,
    })
  }),
  http.get(`${API_BASE_URL}/parcel-drafts/:id`, ({ params }) => {
    const d = draftById(Number(params.id))
    return d
      ? HttpResponse.json({ data: d, meta: meta() })
      : HttpResponse.json(
          { error: { code: 'NOT_FOUND', message: '초안이 없습니다.', details: [] } },
          { status: 404 },
        )
  }),
  http.delete(`${API_BASE_URL}/parcel-drafts/:id`, ({ params }) => {
    draftGone.add(Number(params.id))
    return new HttpResponse(null, { status: 204 })
  }),
  // 원본으로 새 READY 초안 — 같은 clientParcelId면 같은 초안 (응답 유실 재전송)
  http.post(`${API_BASE_URL}/parcel-drafts`, async ({ request }) => {
    const b = (await request.json()) as {
      clientParcelId: string
      sourceDraftSeq: number
      parcel: object
      status: string
    }
    const had = madeDrafts.get(b.clientParcelId)
    if (had) return HttpResponse.json({ data: had, meta: meta() }, { status: 201 })
    const src = draftById(b.sourceDraftSeq)
    if (!src)
      return HttpResponse.json(
        { error: { code: 'NOT_FOUND', message: '원본이 없습니다.', details: [] } },
        { status: 404 },
      )
    const made = {
      ...src,
      ...{
        draftSeq: nextDraft++,
        status: b.status,
        sourceDraftSeq: src.draftSeq,
        legacyOrderSeq: null,
        clientParcelId: b.clientParcelId,
        parcel: { ...src.parcel, ...b.parcel },
      },
    }
    madeDrafts.set(b.clientParcelId, made)
    draftGone.add(src.draftSeq) // 원본은 RESUMED → 미완료에서 빠짐
    return HttpResponse.json({ data: made, meta: meta() }, { status: 201 })
  }),
  // 최종 접수 — 카드면 결제 대기, 월 · 그룹결제면 접수 완료
  http.post(`${API_BASE_URL}/admin/parcel-drafts/:id/submit`, async ({ request, params }) => {
    const b = (await request.json()) as { paymentMethodType?: string }
    return HttpResponse.json({
      data: {
        // 가짜: 새 주문 대신 원본의 옛 주문번호(가짜 저장소에 있는 주문)로 — 패널이 열리게
        orderSeq:
          [...madeDrafts.values()].find((d) => d.draftSeq === Number(params.id))?.sourceDraftSeq ??
          0,
        draftSeq: Number(params.id),
        orderParcelSeq: Number(params.id) * 10 + 1,
        status: b.paymentMethodType === 'billing' ? 'notPaid' : 'ACCEPTED',
        version: 1,
        paymentDueAt: null,
        totalAmount: null,
        callSessionSeq: null,
        parcelNo: null,
      },
      meta: meta(),
    })
  }),
]

export const orderHandlers = [
  ...draftHandlers,
  // q = 보내는 분 · 받는 분의 이름 · 전화번호 · 주소 부분 검색 · from 포함 · to 미포함 · 접수 최신순
  http.get(`${API_BASE_URL}/admin/orders`, ({ request }) => {
    const u = new URL(request.url).searchParams
    const q = u.get('q')?.toLowerCase()
    const group = u.get('statusGroup')
    const from = u.get('from') ? Date.parse(u.get('from')!) : -Infinity
    const to = u.get('to') ? Date.parse(u.get('to')!) : Infinity
    const limit = Number(u.get('limit') ?? 20)
    const offset = Number(u.get('offset') ?? 0)
    // 057 · 058: 전체 = 실제 주문 + 미완료 초안(status COLLECTING, orderSeq = 예약번호, draftSeq), COLLECTING 묶음 = 초안만
    const listed = allOrders()
      .filter((o) => statusOf(o) !== 'COLLECTING' || !draftGone.has(o.orderSeq))
      .map((o) => {
        const item = toListItem(o)
        if (item.status !== 'COLLECTING') return { ...item, draftSeq: null as number | null }
        const d = draftOf(o)
        return {
          ...item,
          orderSeq: d.reservedOrderSeq,
          draftSeq: d.draftSeq as number | null,
          pickupRequestedAt: null,
          parcels: item.parcels
            .slice(0, 1)
            .map((p) => ({ ...p, orderParcelSeq: null, status: 'ACTIVE' })),
        }
      })
      .filter((o) => {
        const at = Date.parse(o.createdAt)
        return (
          at >= from &&
          at < to &&
          (!q ||
            o.parcels.some((p) =>
              [p.origin, p.destination].some((x) =>
                Object.values(x).some((v) => v?.toLowerCase().includes(q)),
              ),
            ))
        )
      })
    const inGroup = (g: string) => (o: (typeof listed)[number]) =>
      (GROUP[g] ?? [g]).includes(o.status)
    const statusCounts = {
      all: listed.length,
      incomplete: listed.filter(inGroup('COLLECTING')).length,
      notPaid: listed.filter(inGroup('notPaid')).length,
      paid: listed.filter(inGroup('PAID')).length,
      accepted: listed.filter(inGroup('ACCEPTED')).length,
      submissionFailed: listed.filter(inGroup('SUBMISSION_FAILED')).length,
      cancelled: listed.filter(inGroup('CANCELLED')).length,
    }
    const rows = listed
      .filter((o) => !group || inGroup(group)(o))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.orderSeq - a.orderSeq)
    return HttpResponse.json({
      data: rows.slice(offset, offset + limit),
      hasNext: offset + limit < rows.length,
      total_count: rows.length,
      statusCounts,
    })
  }),
  http.get(`${API_BASE_URL}/orders/:id`, ({ params }) => {
    const o = allOrders().find((x) => x.orderSeq === Number(params.id))
    if (!o)
      return HttpResponse.json(
        { error: { code: 'NOT_FOUND', message: '주문이 없습니다.', details: [] } },
        { status: 404 },
      )
    return HttpResponse.json({ data: toDto(o), meta: { requestId: crypto.randomUUID() } })
  }),
]
