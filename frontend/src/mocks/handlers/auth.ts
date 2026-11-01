import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'

// 가짜 로그인 (가짜 전용) — 연동 상세명세 10/31 API-01~04 모양. 역할 · 승인 상태별로 화면을 확인하려고 넷, 비밀번호는 모두 test1234
// pending · inactive는 명세대로 로그인이 거절됨(401) — 승인 대기 화면은 가입 직후에만 보임
// admin = 최고 관리자(SYSTEM_ADMIN) · manager = 일반 관리자(SUPERVISOR) · pending = 승인 대기 · inactive = 비활성화
// 가입(AUTH-06)하면 여기에 PENDING으로 붙음(비밀번호 = 가입할 때 넣은 값) — 새로고침하면 사라짐
const ACCOUNTS: {
  adminUserSeq: number
  loginId: string
  name: string
  role: 'OPERATOR' | 'SUPERVISOR' | 'SYSTEM_ADMIN'
  status: 'ACTIVE' | 'PENDING' | 'INACTIVE'
}[] = [
  { adminUserSeq: 1, loginId: 'admin', name: '김관리', role: 'SYSTEM_ADMIN', status: 'ACTIVE' },
  { adminUserSeq: 2, loginId: 'manager', name: '이매니', role: 'SUPERVISOR', status: 'ACTIVE' },
  { adminUserSeq: 3, loginId: 'pending', name: '박대기', role: 'OPERATOR', status: 'PENDING' },
  { adminUserSeq: 4, loginId: 'inactive', name: '최비활', role: 'OPERATOR', status: 'INACTIVE' },
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

const fail = (
  status: number,
  code: string,
  message: string,
  details: { field: string; reason: string }[] = [],
) =>
  HttpResponse.json(
    { error: { code, message, details }, meta: { requestId: crypto.randomUUID() } },
    { status },
  )
const LOGIN_ID = /^[A-Za-z0-9]{1,20}$/ // API-01 · 02
const invalid = (b: Record<string, unknown>, withName: boolean) => {
  const d: { field: string; reason: string }[] = []
  if (typeof b.loginId !== 'string' || !LOGIN_ID.test(b.loginId))
    d.push({ field: 'loginId', reason: 'INVALID_FORMAT' })
  if (typeof b.password !== 'string' || b.password.length < 6)
    d.push({ field: 'password', reason: 'TOO_SHORT' })
  if (withName && (typeof b.name !== 'string' || b.name.trim() === ''))
    d.push({ field: 'name', reason: 'REQUIRED' })
  return d
}

export const authHandlers = [
  http.post(`${API_BASE_URL}/auth/login`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    const details = invalid(body, false)
    if (details.length) return fail(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.', details)
    const { loginId, password } = body as { loginId: string; password: string }
    const found = ACCOUNTS.find((a) => a.loginId === loginId)
    // 명세 API-01: ACTIVE만 로그인. 승인 대기 · 비활성화도 틀린 비밀번호와 같은 401 (상태 코드 구분은 BE 요청 B1)
    if (!found || PASSWORDS.get(loginId) !== password || found.status !== 'ACTIVE')
      return fail(401, 'UNAUTHORIZED', '아이디·비밀번호 또는 로그인 상태를 확인해 주세요.')
    const expiresAt = new Date(Date.now() + SESSION_SEC * 1000).toISOString()
    return HttpResponse.json(
      { data: { expiresAt }, meta: { requestId: crypto.randomUUID() } }, // 실서버: 본문엔 만료 시각만, 사용자 정보는 /auth/me
      { headers: { 'Set-Cookie': sessionCookie(`mock-${found.adminUserSeq}`, SESSION_SEC) } },
    )
  }),
  // AUTH-06 — 204 본문 없음 · 아이디 중복 409 (명세서 p13)
  http.post(`${API_BASE_URL}/auth/signup`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    const details = invalid(body, true)
    if (details.length) return fail(400, 'INVALID_REQUEST', '입력값을 확인해 주세요.', details)
    const { loginId, password, name } = body as { loginId: string; password: string; name: string }
    if (ACCOUNTS.some((a) => a.loginId === loginId))
      return fail(409, 'DUPLICATE_RESOURCE', '이미 사용 중인 로그인 ID입니다.')
    PASSWORDS.set(loginId, password)
    ACCOUNTS.push({
      adminUserSeq: ACCOUNTS.length + 1,
      loginId,
      name,
      role: 'OPERATOR',
      status: 'PENDING',
    })
    return new HttpResponse(null, { status: 204 })
  }),
  http.get(`${API_BASE_URL}/auth/me`, ({ cookies }) => {
    const me = bySession(cookies)
    return me
      ? HttpResponse.json({ data: me, meta: { requestId: crypto.randomUUID() } })
      : fail(401, 'UNAUTHORIZED', '아이디·비밀번호 또는 로그인 상태를 확인해 주세요.')
  }),
  // 쿠키 삭제 (Max-Age=0) — 실서버도 로그아웃에서 세션과 쿠키를 지움
  http.post(
    `${API_BASE_URL}/auth/logout`,
    () => new HttpResponse(null, { status: 204, headers: { 'Set-Cookie': sessionCookie('', 0) } }),
  ),
]
