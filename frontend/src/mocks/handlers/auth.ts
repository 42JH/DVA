import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 로그인 (가짜 전용). 역할 · 승인 상태별로 화면을 확인하려고 넷, 비밀번호는 모두 test1234
// admin = 최고 관리자(SYSTEM_ADMIN) · manager = 일반 관리자(SUPERVISOR) · pending = 승인 대기 · inactive = 비활성화
// 가입(AUTH-06)하면 여기에 PENDING으로 붙음(비밀번호 = 가입할 때 넣은 값) — 새로고침하면 사라짐
const ACCOUNTS: {
  adminUserSeq: number
  loginId: string
  role: 'OPERATOR' | 'SUPERVISOR' | 'SYSTEM_ADMIN'
  status: 'ACTIVE' | 'PENDING' | 'INACTIVE'
}[] = [
  { adminUserSeq: 1, loginId: 'admin', role: 'SYSTEM_ADMIN', status: 'ACTIVE' },
  { adminUserSeq: 2, loginId: 'manager', role: 'SUPERVISOR', status: 'ACTIVE' },
  { adminUserSeq: 3, loginId: 'pending', role: 'OPERATOR', status: 'PENDING' },
  { adminUserSeq: 4, loginId: 'inactive', role: 'OPERATOR', status: 'INACTIVE' },
]
// 비밀번호는 계정과 따로 — /auth/me 응답에 섞이지 않게
const PASSWORDS = new Map(ACCOUNTS.map((a) => [a.loginId, 'test1234']))

// 토큰 ='mock-token-<adminUserSeq>' — 페이지 메모리에 '현재 계정'을 두면 새로고침에 초기화되므로 토큰에 넣어 둠
const byToken = (auth: string | null) =>
  ACCOUNTS.find((a) => auth === `Bearer mock-token-${a.adminUserSeq}`)

const fail = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message, details: [] } }, { status })

export const authHandlers = [
  http.post(`${API_BASE_URL}/auth/login`, async ({ request }) => {
    const { loginId, password } = (await request.json()) as { loginId: string; password: string }
    const found = ACCOUNTS.find((a) => a.loginId === loginId)
    if (!found || PASSWORDS.get(loginId) !== password)
      return fail(401, 'UNAUTHORIZED', '인증에 실패했습니다.')
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    return HttpResponse.json({
      data: { accessToken: `mock-token-${found.adminUserSeq}`, expiresAt },
    })
  }),
  // AUTH-06 — 204 본문 없음 · 아이디 중복 409 (명세서 p13)
  http.post(`${API_BASE_URL}/auth/signup`, async ({ request }) => {
    const { loginId, password } = (await request.json()) as { loginId: string; password: string }
    if (ACCOUNTS.some((a) => a.loginId === loginId))
      return fail(409, 'SIGNUP_UNAVAILABLE', '가입 신청을 할 수 없습니다.')
    PASSWORDS.set(loginId, password)
    ACCOUNTS.push({
      adminUserSeq: ACCOUNTS.length + 1,
      loginId,
      role: 'OPERATOR',
      status: 'PENDING',
    })
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(`${API_BASE_URL}/auth/me`, ({ request }) => {
    const me = byToken(request.headers.get('Authorization'))
    return me ? HttpResponse.json({ data: me }) : fail(401, 'UNAUTHORIZED', '인증에 실패했습니다.')
  }),
  http.post(`${API_BASE_URL}/auth/logout`, () => new HttpResponse(null, { status: 204 })),
]
