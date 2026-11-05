// 상단바 공용 검색 창의 데이터 (11/05 사용자: 모든 화면 상단바 = 상태 · 탭 검색 · 알림). 기능 폴더를 import 못 해서 쓰는 칸만 여기서 받음
// 통화 · 주문은 서버 검색(최근 8건), FAQ · 기업은 전부 받아 화면에서 찾음(초성) — 각 목록 화면과 같은 요청 · 같은 캐시 키
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api, type ApiList } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import { directoryQuery, phoneDigits } from '@/shared/lib/search'

/** 통화 줄 (API-21 통화 목록에서 쓰는 것만) */
export interface CallHit {
  callSessionSeq: number
  customerName: string | null
  callerPhoneNumber: string | null
  startedAt: string | null
}

/** 주문 줄 (03 주문 목록 응답에서 쓰는 것만) */
export interface OrderHit {
  orderSeq: number
  createdAt: string
  parcels: { origin: { name: string | null }; destination: { name: string | null } }[]
}

/** FAQ 줄 (API-29에서 쓰는 것만) */
export interface FaqHit {
  faqEntrySeq: number
  category: string
  question: string
  answer: string
  createdAt: string
}

/** 기업 줄 (08 기업 목록에서 쓰는 것만) */
export interface CompanyHit {
  organizationSeq: number
  name: string
  memberCount: number
}

/** 사원 줄 — GET /companies/search (DIR-01 기업 공식 배송지 검색) 응답에서 쓰는 것만
 *  서버 조건: 활성 기업 · 활성 소속 · 활성 고객 · **기본 주소가 있는 사원만**. 기업명 · 부서명 · 이름 · 전화번호 · 주소에서
 *  띄어쓰기로 나눈 낱말이 모두 들어 있으면 맞음(대소문자 무시). 정렬 = 기업명 · 기업 번호 · 고객 번호 */
export interface MemberHit {
  organizationSeq: number
  organizationName: string
  membershipSeq: number
  departmentName: string | null
  addressData: { name: string; phoneNumber: string } // 전화번호는 숫자만
}

const SHOW = 8
// 숫자만 쳤으면 번호로 ('010-1458' → '0101458' — 서버는 숫자만 저장)
const serverQ = (q: string) => (phoneDigits(q) || q).slice(0, 200)

export const searchQueries = {
  /** 이름 · 전화번호 → 최근 통화 8건 (04와 같은 서버 검색, 최신순) */
  calls: (q: string) =>
    queryOptions({
      queryKey: ['search', 'calls', q],
      queryFn: ({ signal }) =>
        api.get<ApiList<CallHit>>('/calls', {
          query: { q: serverQ(q), limit: SHOW, offset: 0 },
          signal,
        }),
      enabled: q !== '',
      placeholderData: keepPreviousData, // 치는 동안 이전 결과가 남아 깜빡이지 않음
    }),
  /** 이름 · 전화번호 · 주소 → 최근 주문 8건 (서버가 보내는 분 · 받는 분 둘 다에서 찾음, 03과 같은 검색) */
  orders: (q: string) =>
    queryOptions({
      queryKey: ['search', 'orders', q],
      queryFn: ({ signal }) =>
        api.get<ApiList<OrderHit>>('/admin/orders', {
          query: { q: serverQ(q), limit: SHOW, offset: 0 },
          signal,
        }),
      enabled: q !== '',
      placeholderData: keepPreviousData,
    }),
  /** FAQ 전부 — 09 FAQ 목록과 같은 요청 · 같은 캐시 키 */
  faqs: (enabled: boolean) =>
    queryOptions({
      queryKey: ['faqs', 'list'],
      queryFn: ({ signal }) => fetchAll<FaqHit>('/faqs', {}, signal),
      enabled,
    }),
  /** 사원 이름 · 전화번호 · 부서 → 그 사원이 속한 기업 (기업 탭, 11/05). 기업명 줄과 따로 최대 50명 받아 사원 정보로 맞은 줄만 */
  directory: (q: string) =>
    queryOptions({
      queryKey: ['search', 'directory', q],
      queryFn: ({ signal }) =>
        api.get<ApiList<MemberHit>>('/companies/search', {
          query: { q: directoryQuery(q), limit: 50, offset: 0 },
          signal,
        }),
      enabled: directoryQuery(q) !== '',
      placeholderData: keepPreviousData,
    }),
  /** 기업 전부 — 08 기업 목록 검색용과 같은 요청 · 같은 캐시 키 (5분 재사용) */
  companies: (enabled: boolean) =>
    queryOptions({
      queryKey: ['companies', 'pool'],
      queryFn: ({ signal }) => fetchAll<CompanyHit>('/companies', {}, signal),
      staleTime: 5 * 60_000,
      enabled,
    }),
}
