// 가짜 기업 · 부서 · 사원 (08 기업관리, API 연동 상세명세 7장 모양) + 사원 검색 2가지 (shared/search)
// 새로고침하면 처음으로 돌아감. 사원 주소는 고객 정보에 있음 (서버와 같음)
import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { allOrders } from './orderData'

type Status = 'ACTIVE' | 'INACTIVE'
interface Address {
  roadAddress: string
  jibunAddress: string
  detailAddress?: string
  dongName: string
  postalCode: string
}
interface Org {
  organizationSeq: number
  name: string
  status: Status
  monthlyBillingEnabled: boolean
  createdAt: string | null
}
interface Dept {
  departmentSeq: number
  organizationSeq: number
  name: string
  groupBillingEnabled: boolean // 부서 그룹 결제 (백엔드 departments.group_billing_enabled)
}
interface Member {
  membership: {
    membershipSeq: number
    customerSeq: number
    organizationSeq: number
    departmentSeq: number | null
    employeeNo: string
    role: 'MEMBER' | 'ORG_ADMIN'
    status: Status
  }
  customer: {
    customerSeq: number
    name: string
    phoneNumber: string
    address: Address | null
    status: 'ACTIVE'
  }
}

const ORG_NAMES = [
  '디버물류',
  '한빛상사',
  '세종테크',
  '오렌지마켓',
  '(주)서강물산',
  '바른약국',
  '새봄치과',
  '연남베이커리',
  '(주)도담물류',
  '그린팜',
  '(주)온누리전자',
  '하늘인쇄',
  '모아디자인',
  '청솔법무법인',
  '푸른회계사무소',
  '다온건축',
  '(주)새봄식품',
  '별빛스튜디오',
]
const PEOPLE = [
  '김하준',
  '이서연',
  '박지호',
  '최유나',
  '정민재',
  '한소율',
  '오시우',
  '강도윤',
  '윤재석',
  '임채원',
  '서하은',
  '장우진',
  '권나래',
  '문태오',
  '배수지',
  '신예린',
  '조민혁',
  '홍예준',
  '송하린',
  '노유나',
]
const STREETS: [string, string, string, string][] = [
  ['서울 강남구 테헤란로 152', '서울 강남구 역삼동 737', '역삼동', '06236'],
  ['서울 마포구 독막로 301', '서울 마포구 상수동 93', '상수동', '04072'],
  ['서울 성동구 왕십리로 83', '서울 성동구 성수동1가 685', '성수동1가', '04769'],
  ['경기 성남시 분당구 판교역로 166', '경기 성남시 분당구 백현동 532', '백현동', '13529'],
  ['인천 연수구 송도과학로 32', '인천 연수구 송도동 24-4', '송도동', '21984'],
  ['서울 송파구 올림픽로 300', '서울 송파구 신천동 29', '신천동', '05551'],
]
const DEPTS = ['영업팀', '물류팀', '경영지원팀', '총무팀', '디자인팀']

const orgs: Org[] = ORG_NAMES.map((name, i) => ({
  organizationSeq: i + 1,
  name,
  status: 'ACTIVE',
  monthlyBillingEnabled: i % 3 !== 1,
  createdAt: i === 0 ? null : new Date(Date.now() - (i * 9 + 3) * 86_400_000).toISOString(),
}))
const depts: Dept[] = []
const members: Member[] = []
let nextDept = 1
let nextMember = 100
let nextCustomer = 5000

function addMember(
  org: number,
  m: { name: string; phoneNumber: string; employeeNo: string },
  dept: number | null,
  role: Member['membership']['role'] = 'MEMBER',
  address: Address | null = null,
) {
  const customerSeq = nextCustomer++
  members.push({
    membership: {
      membershipSeq: nextMember++,
      customerSeq,
      organizationSeq: org,
      departmentSeq: dept,
      employeeNo: m.employeeNo,
      role,
      status: 'ACTIVE',
    },
    customer: { customerSeq, name: m.name, phoneNumber: m.phoneNumber, address, status: 'ACTIVE' },
  })
}

const SENDERS = [...new Map(allOrders().map((o) => [o.sender.phoneNumber, o.sender])).values()]
// 최근 고객(고객 목록 첫 쪽)에서 고름 — 첫 화면에서도 기업 고객이 섞여 보이게
const senderOf = (n: number, i: number) => SENDERS[SENDERS.length - 1 - ((n * 17 + i) % 150)]

// 기업마다 부서 0~3개 · 사원 4~31명 (번호로 정해져 새로고침해도 같음)
for (const o of orgs) {
  const n = o.organizationSeq
  const mine = Array.from({ length: n % 4 }, (_, k) => {
    const d = {
      departmentSeq: nextDept++,
      organizationSeq: n,
      name: DEPTS[(n + k) % DEPTS.length],
      groupBillingEnabled: k % 2 === 0,
    }
    depts.push(d)
    return d.departmentSeq
  })
  const count = 4 + ((n * 7) % 28)
  for (let i = 0; i < count; i++) {
    const s = STREETS[(n + i) % STREETS.length]
    addMember(
      n,
      {
        // 세 명에 한 명은 주문을 보낸 고객과 같은 사람 — 고객 화면에서 '기업 고객 · 그룹 결제'가 보이게
        name: i % 3 === 0 ? senderOf(n, i).name : PEOPLE[(n * 3 + i) % PEOPLE.length],
        phoneNumber:
          i % 3 === 0
            ? senderOf(n, i).phoneNumber
            : `010${String(10000000 + n * 1_000_003 + i * 7919).slice(-8)}`,
        employeeNo: String(1000 + i + 1).padStart(6, '0'),
      },
      mine.length ? (mine[i % (mine.length + 1)] ?? null) : null,
      i < 1 + (n % 2) ? 'ORG_ADMIN' : 'MEMBER',
      i % 5 === 4
        ? null
        : {
            roadAddress: s[0],
            jibunAddress: s[1],
            detailAddress: `${(i % 12) + 2}층`,
            dongName: s[2],
            postalCode: s[3],
          },
    )
  }
}

/** 전화번호로 활성 소속 찾기 — 가짜 POST /customers/context가 씀 (백엔드 customers.repository context와 같은 JOIN) */
export function membershipByPhone(phone: string) {
  const m = members.find(
    (x) => x.customer.phoneNumber === phone && x.membership.status === 'ACTIVE',
  )
  if (!m) return null
  const org = orgs.find((o) => o.organizationSeq === m.membership.organizationSeq)
  if (!org) return null
  const dept = depts.find((d) => d.departmentSeq === m.membership.departmentSeq) ?? null
  return { membership: m.membership, org, dept }
}

const orgOf = (id: unknown) => orgs.find((o) => o.organizationSeq === Number(id))
const memberCount = (id: number) =>
  members.filter((m) => m.membership.organizationSeq === id && m.membership.status === 'ACTIVE')
    .length
const active = (id: number) =>
  members.filter((m) => m.membership.organizationSeq === id && m.membership.status === 'ACTIVE')
const deptMembers = (seq: number) =>
  members.filter((m) => m.membership.departmentSeq === seq && m.membership.status === 'ACTIVE')
    .length
const addr = (a: Address | null) => (a ? `${a.roadAddress} ${a.detailAddress ?? ''}`.trim() : '')

// 청구 내역 (백엔드에 요청한 GET /companies/{id}/billing/charges 계약) — 사원이 다른 기업 사원에게 보낸 월결제 건
// 번호 · 달로 정해져 새로고침해도 같음. 이번 달은 오늘까지만
const PRICES = [4950, 6000, 8000, 10000, 12000]
const BOXES = ['서류 1건', '소박스 1개', '중박스 1개', '대박스 1개']
function chargesOf(id: number, month: string) {
  const mine = active(id)
  const others = members.filter(
    (m) => m.membership.organizationSeq !== id && m.membership.status === 'ACTIVE',
  )
  if (!mine.length || !others.length) return []
  const [y, mo] = month.split('-').map(Number)
  const now = new Date()
  const lastDay =
    y === now.getFullYear() && mo === now.getMonth() + 1
      ? now.getDate()
      : new Date(y, mo, 0).getDate()
  const n = (id * 5 + mo) % 9
  return Array.from({ length: n }, (_, i) => {
    const s = mine[(i * 3 + id) % mine.length]
    const r = others[(i * 7 + id * 11 + mo) % others.length]
    const ro = orgs.find((o) => o.organizationSeq === r.membership.organizationSeq)!
    const amount = PRICES[(i + id + mo) % PRICES.length]
    const day = Math.max(1, lastDay - Math.floor((i * lastDay) / Math.max(n, 1)))
    return {
      orderSeq: 200 + id * 37 + mo * 11 + i,
      paidAt: new Date(y, mo - 1, day, 9 + ((i * 5) % 9), (i * 17) % 60).toISOString(),
      amount,
      sender: {
        name: s.customer.name,
        phoneNumber: s.customer.phoneNumber,
        departmentName:
          depts.find((d) => d.departmentSeq === s.membership.departmentSeq)?.name ?? null,
        address: addr(s.customer.address),
      },
      recipient: {
        organizationName: ro.name,
        name: r.customer.name,
        phoneNumber: r.customer.phoneNumber,
        address: addr(r.customer.address),
      },
      items: [{ label: BOXES[(i + id) % BOXES.length], amount }],
    }
  })
}
const thisMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const summary = (o: Org) => ({
  ...o,
  memberCount: memberCount(o.organizationSeq),
  // 목록용으로 백엔드에 요청한 칸
  departmentCount: depts.filter((d) => d.organizationSeq === o.organizationSeq).length,
  managerNames: active(o.organizationSeq)
    .filter((m) => m.membership.role === 'ORG_ADMIN')
    .map((m) => m.customer.name),
  monthlyAmount: chargesOf(o.organizationSeq, thisMonth()).reduce((n, c) => n + c.amount, 0),
})
const page = <T>(rows: T[], url: URL) => {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 20)))
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0))
  return {
    data: rows.slice(offset, offset + limit),
    hasNext: offset + limit < rows.length,
    total_count: rows.length,
  }
}
const notFound = () =>
  HttpResponse.json(
    { error: { code: 'NOT_FOUND', message: '기업이 없습니다.', details: [] } },
    { status: 404 },
  )
const noContent = () => new HttpResponse(null, { status: 204 })
const created = (data: object) => HttpResponse.json({ data }, { status: 201 })

type NewMember = {
  employeeNo: string
  name: string
  phoneNumber: string
  role?: Member['membership']['role']
  departmentSeq?: number | null
  departmentName?: string
}
/** 사번이 같으면 고객 정보 갱신(= 수정), 없으면 새 사원 — POST /companies/{id}/members 규칙 */
function upsert(org: number, items: NewMember[], deptByName = new Map<string, number>()) {
  for (const it of items) {
    const dept = it.departmentName
      ? (deptByName.get(it.departmentName) ?? null)
      : (it.departmentSeq ?? null)
    const old = members.find(
      (m) => m.membership.organizationSeq === org && m.membership.employeeNo === it.employeeNo,
    )
    if (old) {
      old.customer.name = it.name
      old.customer.phoneNumber = it.phoneNumber
      old.membership.departmentSeq = dept
      old.membership.status = 'ACTIVE'
      if (it.role) old.membership.role = it.role
    } else addMember(org, it, dept, it.role)
  }
}

export const companyHandlers = [
  // 관리자 사원 검색 — 이름 · 전화(숫자) · 사번 · 부서, 낱말 모두 (shared/search)
  http.get(`${API_BASE_URL}/companies/members/search`, ({ request }) => {
    const url = new URL(request.url)
    const inactive = url.searchParams.get('includeInactive') === 'true'
    const words = (url.searchParams.get('q') ?? '').trim().split(/\s+/).filter(Boolean)
    const rows = members
      .filter((m) => inactive || m.membership.status === 'ACTIVE')
      .map((m) => {
        const o = orgOf(m.membership.organizationSeq)!
        return {
          organizationSeq: o.organizationSeq,
          organizationName: o.name,
          organizationStatus: o.status,
          membershipSeq: m.membership.membershipSeq,
          membershipStatus: m.membership.status,
          employeeNo: m.membership.employeeNo,
          departmentName:
            depts.find((d) => d.departmentSeq === m.membership.departmentSeq)?.name ?? null,
          name: m.customer.name,
          phoneNumber: m.customer.phoneNumber,
        }
      })
      .filter((r) =>
        words.every((w) =>
          /^[\d-]+$/.test(w)
            ? r.phoneNumber.includes(w.replace(/-/g, '')) || r.employeeNo.includes(w)
            : [r.name, r.employeeNo, r.departmentName ?? '', r.organizationName]
                .join(' ')
                .toLowerCase()
                .includes(w.toLowerCase()),
        ),
      )
    return HttpResponse.json(page(rows, url))
  }),
  http.get(`${API_BASE_URL}/companies`, ({ request }) => {
    const url = new URL(request.url)
    const q = url.searchParams.get('q')?.trim() ?? ''
    const rows = orgs
      .filter((o) => !q || o.name.includes(q))
      .sort((a, b) => b.organizationSeq - a.organizationSeq)
      .map(summary)
    return HttpResponse.json(page(rows, url))
  }),
  // 기업 + 부서 + 사원을 한 번에 (CSV 기업 등록)
  http.post(`${API_BASE_URL}/companies`, async ({ request }) => {
    const b = (await request.json()) as {
      name: string
      departments?: { name: string }[]
      members?: NewMember[]
    }
    const id = Math.max(...orgs.map((o) => o.organizationSeq)) + 1
    orgs.push({
      organizationSeq: id,
      name: b.name,
      status: 'ACTIVE',
      monthlyBillingEnabled: false,
      createdAt: new Date().toISOString(),
    })
    const byName = new Map<string, number>()
    for (const d of b.departments ?? []) {
      depts.push({
        departmentSeq: nextDept,
        organizationSeq: id,
        name: d.name,
        groupBillingEnabled: false,
      })
      byName.set(d.name, nextDept++)
    }
    upsert(id, b.members ?? [], byName)
    return created({ organizationSeq: id })
  }),
  // 월 사용액 (API-34, month 'YYYY-MM' · 생략 = 이번 달). 가짜 금액은 기업 번호로 고정
  // 이 처리가 없으면 목업에서 진짜 서버로 넘어가 401 → 로그아웃돼 기업 상세를 못 봤음 (QA)
  http.get(`${API_BASE_URL}/companies/:id/billing`, ({ params, request }) => {
    const o = orgOf(params.id)
    if (!o) return notFound()
    const id = Number(params.id)
    const month = new URL(request.url).searchParams.get('month') ?? thisMonth()
    return HttpResponse.json({
      data: {
        organizationSeq: id,
        organizationName: o.name,
        month,
        monthlyAmount: chargesOf(id, month).reduce((n, c) => n + c.amount, 0),
        groupBillingAmount: 0,
      },
    })
  }),
  http.get(`${API_BASE_URL}/companies/:id/billing/charges`, ({ params, request }) => {
    if (!orgOf(params.id)) return notFound()
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim()
    const rows = chargesOf(Number(params.id), url.searchParams.get('month') ?? thisMonth()).filter(
      (c) =>
        !q ||
        c.sender.name.includes(q) ||
        c.recipient.organizationName.includes(q) ||
        c.recipient.name.includes(q) ||
        String(c.orderSeq).includes(q.replace(/^DV-0*/i, '')),
    )
    return HttpResponse.json({
      ...page(rows, url),
      total_amount: rows.reduce((n, c) => n + c.amount, 0),
    })
  }),
  http.get(`${API_BASE_URL}/companies/:id`, ({ params }) => {
    const o = orgOf(params.id)
    return o ? HttpResponse.json({ data: summary(o) }) : notFound()
  }),
  // 기업명 · 월결제 바꾸기 (API PATCH /companies/:id)
  http.patch(`${API_BASE_URL}/companies/:id`, async ({ params, request }) => {
    const o = orgOf(params.id)
    if (!o) return notFound()
    const b = (await request.json()) as { name?: string; monthlyBillingEnabled?: boolean }
    if (b.name !== undefined) o.name = b.name.trim()
    if (b.monthlyBillingEnabled !== undefined) o.monthlyBillingEnabled = b.monthlyBillingEnabled
    return HttpResponse.json({ data: summary(o) })
  }),
  // 여러 곳 한 번에 — 하나라도 없으면 404, 아무것도 안 지움
  http.delete(`${API_BASE_URL}/companies`, async ({ request }) => {
    const { organizationSeqs: ids } = (await request.json()) as { organizationSeqs: number[] }
    if (!ids.every((id) => orgs.some((o) => o.organizationSeq === id))) return notFound()
    for (const id of ids) {
      orgs.splice(
        orgs.findIndex((o) => o.organizationSeq === id),
        1,
      )
      for (let k = members.length - 1; k >= 0; k--)
        if (members[k].membership.organizationSeq === id) members.splice(k, 1)
    }
    return noContent()
  }),
  http.get(`${API_BASE_URL}/companies/:id/members`, ({ params, request }) => {
    if (!orgOf(params.id)) return notFound()
    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
    const digits = /^[0-9-]+$/.test(q) ? q.replace(/-/g, '') : ''
    // 서버와 같음: 이름 · 사번 부분 일치(대소문자 무시) 또는 숫자 · 하이픈이면 전화번호(하이픈 무시)
    const rows = members.filter(
      (m) =>
        m.membership.organizationSeq === Number(params.id) &&
        (!q ||
          m.customer.name.toLowerCase().includes(q) ||
          m.membership.employeeNo.toLowerCase().includes(q) ||
          (!!digits && m.customer.phoneNumber.includes(digits))),
    )
    return HttpResponse.json(page(rows, url))
  }),
  http.post(`${API_BASE_URL}/companies/:id/members`, async ({ params, request }) => {
    if (!orgOf(params.id)) return notFound()
    upsert(Number(params.id), ((await request.json()) as { items: NewMember[] }).items)
    return noContent()
  }),
  http.get(`${API_BASE_URL}/companies/:id/departments`, ({ params, request }) => {
    if (!orgOf(params.id)) return notFound()
    const rows = depts
      .filter((d) => d.organizationSeq === Number(params.id))
      .map(({ departmentSeq, name }) => ({
        departmentSeq,
        name,
        memberCount: deptMembers(departmentSeq),
      }))
    return HttpResponse.json(page(rows, new URL(request.url)))
  }),
  http.post(`${API_BASE_URL}/companies/:id/departments`, async ({ params, request }) => {
    const org = Number(params.id)
    if (!orgOf(org)) return notFound()
    const { name } = (await request.json()) as { name: string }
    if (depts.some((d) => d.organizationSeq === org && d.name === name))
      return HttpResponse.json(
        {
          error: {
            code: 'DUPLICATE_RESOURCE',
            message: '같은 이름의 부서가 있습니다.',
            details: [],
          },
        },
        { status: 409 },
      )
    depts.push({ departmentSeq: nextDept, organizationSeq: org, name, groupBillingEnabled: false })
    return created({ departmentSeq: nextDept++ })
  }),
  http.patch(`${API_BASE_URL}/departments/:seq`, async ({ params, request }) => {
    const d = depts.find((x) => x.departmentSeq === Number(params.seq))
    if (!d) return notFound()
    const b = (await request.json()) as { name?: string }
    if (b.name !== undefined) d.name = b.name.trim()
    return noContent()
  }),
  // 부서 삭제 — 백엔드와 같게 그 부서 사원의 소속도 해제
  // 배열 하나 = 한 트랜잭션: 하나라도 없으면 아무것도 안 지움
  http.delete(`${API_BASE_URL}/departments`, async ({ request }) => {
    const ids = ((await request.json()) as { departmentSeqs: number[] }).departmentSeqs
    if (ids.some((id) => !depts.some((x) => x.departmentSeq === id))) return notFound()
    for (let k = depts.length - 1; k >= 0; k--)
      if (ids.includes(depts[k].departmentSeq)) depts.splice(k, 1)
    for (let k = members.length - 1; k >= 0; k--) {
      const d = members[k].membership.departmentSeq
      if (d !== null && ids.includes(d)) members.splice(k, 1)
    }
    return noContent()
  }),
  http.patch(`${API_BASE_URL}/members/:seq`, async ({ params, request }) => {
    const m = members.find((x) => x.membership.membershipSeq === Number(params.seq))
    if (!m) return notFound()
    m.membership.role = ((await request.json()) as { role: Member['membership']['role'] }).role
    return noContent()
  }),
  http.delete(`${API_BASE_URL}/members`, async ({ request }) => {
    const ids = ((await request.json()) as { membershipSeqs: number[] }).membershipSeqs
    if (ids.some((id) => !members.some((x) => x.membership.membershipSeq === id))) return notFound()
    for (let k = members.length - 1; k >= 0; k--)
      if (ids.includes(members[k].membership.membershipSeq)) members.splice(k, 1)
    return noContent()
  }),
]
