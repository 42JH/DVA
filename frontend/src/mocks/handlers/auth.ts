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

// 실서버처럼 쿠키 dva_session = 'mock-<adminUserSeq>' (API 연동 상세명세 1장). 페이지 메모리에 '현재 계정'을 두면 새로고침에 초기화되므로 쿠키에
// shortcut: 실서버 쿠키는 HttpOnly지만 MSW는 document.cookie에 써서 HttpOnly를 못 붙임(붙이면 브라우저가 버림) — 가짜 전용이라 그대로
const SESSION_SEC = 9 * 60 * 60 // 세션 9시간 고정
// Path=/api는 실서버 쿠키와 같게: 다르면 가짜 → 실서버로 바꿀 때 덮어쓰지 못하고 dva_session이 둘 → 서버가 가짜 값을 읽어 401 (10/31 겪음)
const sessionCookie = (value: string, maxAge: number) =>
  `dva_session=${value}; Path=/api; Max-Age=${maxAge}; SameSite=Lax`
const bySession = (cookies: Record<string, string>) =>
  ACCOUNTS.find((a) => cookies.dva_session === `mock-${a.adminUserSeq}`)

const fail = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message, details: [] } }, { status })

export const authHandlers = [
  http.post(`${API_BASE_URL}/auth/login`, async ({ request }) => {
    const { loginId, password } = (await request.json()) as { loginId: string; password: string }
    const found = ACCOUNTS.find((a) => a.loginId === loginId)
    if (!found || PASSWORDS.get(loginId) !== password)
      return fail(401, 'UNAUTHORIZED', '인증에 실패했습니다.')
    const expiresAt = new Date(Date.now() + SESSION_SEC * 1000).toISOString()
    return HttpResponse.json(
      { data: { expiresAt } }, // 실서버: 본문엔 만료 시각만, 사용자 정보는 /auth/me
      { headers: { 'Set-Cookie': sessionCookie(`mock-${found.adminUserSeq}`, SESSION_SEC) } },
    )
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
  http.get(`${API_BASE_URL}/auth/me`, ({ cookies }) => {
    const me = bySession(cookies)
    return me ? HttpResponse.json({ data: me }) : fail(401, 'UNAUTHORIZED', '인증에 실패했습니다.')
  }),
  // 쿠키 삭제 (Max-Age=0) — 실서버도 로그아웃에서 세션과 쿠키를 지움
  http.post(
    `${API_BASE_URL}/auth/logout`,
    () => new HttpResponse(null, { status: 204, headers: { 'Set-Cookie': sessionCookie('', 0) } }),
  ),
]
