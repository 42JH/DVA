// 내 비밀번호 변경 — API-05 PATCH /auth/password (API 연동 상세명세 3장)
// 성공 204(본문 없음) 후 서버가 내 모든 세션을 끊음 → 화면은 다시 로그인으로. 현재 비밀번호 불일치 · 새 비밀번호 조건 오류는 422
import { api } from '@/shared/api/client'

export interface PasswordChangeBody {
  currentPassword: string
  newPassword: string // 6자 이상
  newPasswordConfirm: string // 화면에서 같은지 검사해도 서버가 다시 검사하므로 그대로 보냄 (명세: 세 칸 모두 필수)
}

export const changePassword = (body: PasswordChangeBody): Promise<void> =>
  api.patch('/auth/password', { body })
