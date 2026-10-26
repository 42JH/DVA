import { http, HttpResponse } from 'msw'
import { API_BASE_URL } from '../../shared/api/client'

// 가짜 로그인 — 와이어프레임 예시 관리자 이재훈. 이 아이디면 비밀번호는 아무 값이나 통과 (가짜 전용)
const ME = {
  adminUserSeq: 1,
  loginId: 'jaehoon.lee@dver.co.kr',
  role: 'SYSTEM_ADMIN',
  status: 'ACTIVE',
}

const unauthorized = () =>
  HttpResponse.json(
    { error: { code: 'UNAUTHORIZED', message: '인증에 실패했습니다.', details: [] } },
    { status: 401 },
  )

export const authHandlers = [
  http.post(`${API_BASE_URL}/auth/login`, async ({ request }) => {
    const { loginId } = (await request.json()) as { loginId: string }
    if (loginId !== ME.loginId) return unauthorized()
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    return HttpResponse.json({ data: { accessToken: 'mock-access-token', expiresAt } })
  }),
  http.get(`${API_BASE_URL}/auth/me`, ({ request }) =>
    request.headers.get('Authorization') ? HttpResponse.json({ data: ME }) : unauthorized(),
  ),
  http.post(`${API_BASE_URL}/auth/logout`, () => new HttpResponse(null, { status: 204 })),
]
