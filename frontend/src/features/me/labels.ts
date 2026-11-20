// 11 내 정보 — 서버 오류 코드 → 화면 문구 (컨벤션: 코드는 labels.ts에서 글자로)
// 비밀번호 변경 422의 details[].reason이 문장이 아니라 코드로 옴 (실서버 확인 11/01: currentPassword · INCORRECT_PASSWORD)
// 코드 목록은 백엔드 답: reason → 칸(field)
export const PASSWORD_REASON: Record<string, string> = {
  INCORRECT_PASSWORD: '기존 비밀번호가 일치하지 않습니다.', // currentPassword — 라벨 '기존' · 앱의 '…일치하지 않습니다.' 말투
  PASSWORD_POLICY_VIOLATION: '비밀번호는 6자 이상 입력해 주세요.', // newPassword — 화면 검사와 같은 문장
  PASSWORD_MISMATCH: '비밀번호가 일치하지 않습니다.', // newPasswordConfirm — 화면 검사와 같은 문장
}

// 표에 없는 코드도 그대로 보이지 않게
export const PASSWORD_REASON_FALLBACK = '입력한 비밀번호를 확인해 주세요.'
