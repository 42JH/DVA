// 고객 검색어 → 서버 조건 (순수 함수 — 테스트하려고 api 파일과 나눔, orderDto와 같은 방식)
/** 검색어 → 서버 조건. 숫자 11자리면 전화번호(서버는 정확히 일치만), 숫자가 아니면 이름 부분 검색, 숫자 일부는 조건 없음
 *  shortcut: 번호 일부 검색은 서버 미지원 — 백엔드 요청함(jiw/backend-todo 17). 지원되면 여기 한 곳만 바꿈 */
export function customerSearch(text: string): { phoneNumber: string } | { q: string } | null {
  const t = text.trim()
  const digits = t.replace(/\D/g, '')
  if (/^01\d{9}$/.test(digits)) return { phoneNumber: digits }
  if (t && !/^\d+$/.test(t)) return { q: t }
  return null
}
