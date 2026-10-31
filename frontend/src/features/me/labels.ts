// 11 내 정보 — 서버 오류 코드 → 화면 문구 (컨벤션: 코드는 labels.ts에서 글자로)
// 비밀번호 변경 422의 details[].reason이 문장이 아니라 코드로 옴 (실서버 확인 11/01: currentPassword · INCORRECT_PASSWORD)
export const PASSWORD_REASON: Record<string, string> = {
  INCORRECT_PASSWORD: '기존 비밀번호가 일치하지 않습니다.', // 라벨 '기존' · 앱의 '…일치하지 않습니다.'와 같은 말투
}

// 표에 없는 코드도 그대로 보이지 않게 — 신규 비밀번호 쪽 코드는 명세에 없어 아직 모름
export const PASSWORD_REASON_FALLBACK = '입력한 비밀번호를 확인해 주세요.'
