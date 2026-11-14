// 가짜 고객 목록 GET /customers · 상세 GET /customers/:id · 개인 주소록 GET /customers/:id/pins (백엔드 develop-backend 11/06 모양 그대로)
// 가짜 주문의 보내는 분 = 고객(전화번호로 하나), 그 고객이 보낸 받는 분 = 주소록 — '고객' 화면 확인용
import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { allOrders } from './orderData'
import { membershipByPhone } from './companies'

type Addr = {
  name: string
  phoneNumber: string
  roadAddress: string
  jibunAddress: string
  detailAddress?: string
  dongName: string
  postalCode: string
}

function customers() {
  const byPhone = new Map<
    string,
    {
      customerSeq: number
      name: string
      phoneNumber: string
      address: Addr | null
      monthlyBillingEnabled: boolean
      status: 'ACTIVE'
      pins: Addr[]
    }
  >()
  for (const o of allOrders()) {
    const s = o.sender
    if (!s.phoneNumber) continue
    let c = byPhone.get(s.phoneNumber)
    if (!c) {
      c = {
        customerSeq: 1000 + byPhone.size,
        name: s.name,
        phoneNumber: s.phoneNumber,
        address: s.roadAddress
          ? {
              name: s.name,
              phoneNumber: s.phoneNumber,
              roadAddress: s.roadAddress,
              jibunAddress: s.jibunAddress ?? s.roadAddress,
              detailAddress: s.detailAddress ?? '',
              dongName: s.dongName ?? '',
              postalCode: s.postalCode ?? '00000',
            }
          : null,
        monthlyBillingEnabled: o.paymentMethod === 'MONTHLY',
        status: 'ACTIVE',
        pins: [],
      }
      byPhone.set(s.phoneNumber, c)
    }
    const r = o.receiver
    if (r.roadAddress && !c.pins.some((p) => p.roadAddress === r.roadAddress && p.name === r.name))
      c.pins.push({
        name: r.name,
        phoneNumber: r.phoneNumber,
        roadAddress: r.roadAddress,
        jibunAddress: r.jibunAddress ?? r.roadAddress,
        detailAddress: r.detailAddress ?? '',
        dongName: r.dongName ?? '',
        postalCode: r.postalCode ?? '00000',
      })
  }
  return [...byPhone.values()].sort((a, b) => b.customerSeq - a.customerSeq) // 고객 번호 내림차순 (서버와 같음)
}

const page = <T>(rows: T[], url: URL) => {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
  return {
    data: rows.slice(offset, offset + limit),
    hasNext: offset + limit < rows.length,
    total_count: rows.length,
  }
}
// 응답엔 주소록을 안 실음 (서버 고객 응답과 같은 칸만)
const strip = (c: ReturnType<typeof customers>[number]) => ({
  customerSeq: c.customerSeq,
  name: c.name,
  phoneNumber: c.phoneNumber,
  address: c.address,
  monthlyBillingEnabled: c.monthlyBillingEnabled,
  status: c.status,
})

// 쓸 수 있는 결제 — 백엔드 SQL과 같음 (context · 고객 목록 공용): billing 항상 · credit 일반 고객은 고객 허용,
// 기업 고객은 기업 허용 · groupBilling 소속 부서가 허용 (가짜 고객은 탈퇴가 없음)
function paymentsOf(c: ReturnType<typeof customers>[number]) {
  const m = membershipByPhone(c.phoneNumber)
  const org = m && m.org.status === 'ACTIVE' ? m.org : null
  const methods = ['billing']
  if ((!m && c.monthlyBillingEnabled) || org?.monthlyBillingEnabled) methods.push('credit')
  if (org && m?.dept?.groupBillingEnabled) methods.push('groupBilling')
  return methods
}

export const customerHandlers = [
  // 고객 확인 (백엔드 POST /customers/context — AI · 관리자 공용). 쓸 수 있는 결제 계산은 백엔드 SQL과 같음:
  // billing(개인카드) 항상 · credit(월결제) 일반 고객은 고객 허용, 기업 고객은 기업 허용 · groupBilling(그룹카드) 소속 부서가 허용
  http.post(`${API_BASE_URL}/customers/context`, async ({ request }) => {
    const { phoneNumber } = (await request.json()) as { phoneNumber: string }
    const c = customers().find((x) => x.phoneNumber === phoneNumber)
    if (!c)
      return HttpResponse.json({
        data: {
          lookupStatus: 'UNREGISTERED',
          customer: null,
          membership: null,
          organization: null,
          department: null,
          availablePaymentMethods: [],
          availableUsageTypes: [],
          personalPins: [],
          companyPins: [],
        },
      })
    const m = membershipByPhone(phoneNumber)
    const org = m && m.org.status === 'ACTIVE' ? m.org : null
    const methods = paymentsOf(c)
    return HttpResponse.json({
      data: {
        lookupStatus: 'REGISTERED',
        customer: strip(c),
        membership: m?.membership ?? null,
        organization: m && {
          organizationSeq: m.org.organizationSeq,
          name: m.org.name,
          status: m.org.status,
          monthlyBillingEnabled: m.org.monthlyBillingEnabled,
        },
        department: m?.dept ?? null,
        availablePaymentMethods: methods,
        availableUsageTypes: org ? ['PERSONAL', 'COMPANY'] : ['PERSONAL'],
        personalPins: [],
        companyPins: [],
      },
    })
  }),
  http.get(`${API_BASE_URL}/customers`, ({ request }) => {
    const url = new URL(request.url)
    const q = url.searchParams.get('q')?.trim() ?? ''
    const phone = url.searchParams.get('phoneNumber') ?? ''
    const rows = customers().filter(
      (c) => (!q || c.name.includes(q)) && (!phone || c.phoneNumber === phone),
    )
    return HttpResponse.json(
      page(
        rows.map((c) => ({ ...strip(c), availablePaymentMethods: paymentsOf(c) })),
        url,
      ),
    )
  }),
  http.get(`${API_BASE_URL}/customers/:id`, ({ params }) => {
    const c = customers().find((x) => x.customerSeq === Number(params.id))
    return c
      ? HttpResponse.json({ data: strip(c) })
      : HttpResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
  }),
  // 월결제 누적 (백엔드 GET /customers/{id}/billing — month 생략 = 이번 달). 가짜 금액은 고객 번호로 고정
  http.get(`${API_BASE_URL}/customers/:id/billing`, ({ params, request }) =>
    HttpResponse.json({
      data: {
        customerSeq: Number(params.id),
        month:
          new URL(request.url).searchParams.get('month') ?? new Date().toISOString().slice(0, 7),
        monthlyAmount: (Number(params.id) % 7) * 12500,
      },
    }),
  ),
  // 고객정보 저장(주문 '고객정보에도 저장' · 사원 주소) — 가짜 고객은 주문에서 만들어서 저장은 받기만 함
  http.patch(`${API_BASE_URL}/customers/:id`, () => new HttpResponse(null, { status: 204 })),
  http.get(`${API_BASE_URL}/customers/:id/pins`, ({ params, request }) => {
    const c = customers().find((x) => x.customerSeq === Number(params.id))
    if (!c) return HttpResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
    const rows = c.pins.map((p, i) => ({
      personalPinSeq: c.customerSeq * 10 + i,
      version: 1,
      customerSeq: c.customerSeq,
      label: i === 0 ? '자주 보내는 곳' : null,
      addressData: p,
    }))
    return HttpResponse.json(page(rows, new URL(request.url)))
  }),
]
