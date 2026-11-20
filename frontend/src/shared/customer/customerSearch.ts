// 고객 검색어 → 서버 조건 (순수 함수 — 테스트하려고 api 파일과 나눔, orderDto와 같은 방식)
/** 숫자(하이픈 · 띄어쓰기 허용)면 전화번호 부분 검색, 아니면 이름 부분 검색. 빈 칸이면 조건 없음
 *  서버는 번호 1~11자리 어디든 일치 (백엔드 반영). 1~3자리는 거의 모든 고객이 걸려 4자리부터 */
export function customerSearch(text: string): { phoneNumber: string } | { q: string } | null {
  const t = text.trim()
  if (/^[\d\s-]+$/.test(t)) {
    const digits = t.replace(/\D/g, '')
    return digits.length >= 4 && digits.length <= 11 ? { phoneNumber: digits } : null
  }
  return t ? { q: t } : null
}
