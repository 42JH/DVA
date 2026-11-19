// 회원가입 신청 — AUTH-06 (명세서 p13) + 이름 (00 디자인). 204 본문 없음 · 토큰 안 줌 → 승인 대기 화면으로
import { api } from '@/shared/api/client'

interface SignupBody {
  loginId: string
  password: string
  name: string
}

export const signup = (body: SignupBody): Promise<void> => api.post('/auth/signup', { body })
