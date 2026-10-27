import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '../../shared/api/client'

// 가짜 로그인 — 아이디만 맞으면 비밀번호는 아무 값이나 통과 (가짜 전용). 역할 · 승인 상태별로 화면을 확인하려고 셋
// jaehoon.lee = 슈퍼바이저(SYSTEM_ADMIN) · supervisor = 일반 관리자(SUPERVISOR) · pending = 승인 대기
const ACCOUNTS = [
  { adminUserSeq: 1, loginId: 'jaehoon.lee@dver.co.kr', role: 'SYSTEM_ADMIN', status: 'ACTIVE' },
  { adminUserSeq: 2, loginId: 'supervisor@dver.co.kr', role: 'SUPERVISOR', status: 'ACTIVE' },
  { adminUserSeq: 3, loginId: 'pending@dver.co.kr', role: 'SUPERVISOR', status: 'PENDING' },
] as const

// 토큰 = 'mock-token-<adminUserSeq>' — 페이지 메모리에 '현재 계정'을 두면 새로고침에 초기화되므로 토큰에 넣어 둠
const byToken = (auth: string | null) =>
  ACCOUNTS.find((a) => auth === `Bearer mock-token-${a.adminUserSeq}`)

const unauthorized = () =>
  HttpResponse.json(
    { error: { code: 'UNAUTHORIZED', message: '인증에 실패했습니다.', details: [] } },
    { status: 401 },
  )

export const authHandlers = [
  http.post(`${API_BASE_URL}/auth/login`, async ({ request }) => {
    const { loginId } = (await request.json()) as { loginId: string }
    const found = ACCOUNTS.find((a) => a.loginId === loginId)
    if (!found) return unauthorized()
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    return HttpResponse.json({
      data: { accessToken: `mock-token-${found.adminUserSeq}`, expiresAt },
    })
  }),
  http.get(`${API_BASE_URL}/auth/me`, ({ request }) => {
    const me = byToken(request.headers.get('Authorization'))
    return me ? HttpResponse.json({ data: me }) : unauthorized()
  }),
  http.post(`${API_BASE_URL}/auth/logout`, () => new HttpResponse(null, { status: 204 })),
]
