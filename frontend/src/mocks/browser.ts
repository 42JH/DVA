import { http, HttpResponse } from 'msw'
import { setupWorker } from 'msw/browser'
import { API_BASE_URL } from '@/shared/api/client'
import { handlers } from './handlers'

// 개발 서버용 가짜 API (main.tsx가 VITE_USE_MOCK=true일 때 켬)
// 빈 화면 보기: 주소 뒤에 ?mock=empty → 목록이 모두 빈 채로 옴 (새로고침해도 유지). ?mock=full 이면 원래대로
const mode = new URLSearchParams(location.search).get('mock')
if (mode === 'empty') localStorage.setItem('mock-empty', '1')
if (mode === 'full') localStorage.removeItem('mock-empty')

const LISTS = [
  '/admin/orders',
  '/calls',
  '/calls/:id/transcript',
  '/calls/:id/actions',
  '/calls/:id/processing-results',
  '/unanswered-questions',
  '/faqs',
  '/customers',
  '/customers/:id/pins',
  '/companies',
  '/companies/:id/members',
  '/companies/members/search',
  '/admins',
]
const empty = LISTS.map((path) =>
  http.get(`${API_BASE_URL}${path}`, () =>
    HttpResponse.json({ data: [], hasNext: false, total_count: 0 }),
  ),
)

export const worker = setupWorker(...(localStorage.getItem('mock-empty') ? empty : []), ...handlers)
