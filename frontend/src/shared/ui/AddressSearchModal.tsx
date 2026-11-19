// 주소 검색 — 03 주문(보내는 분 · 받는 분) · 08 사원 주소 공용 (shared로 옮김)
// 카카오 우편번호 서비스 화면을 창 안에 띄움 (키 · 서버 없이 브라우저에서 바로). 한 줄을 고르면 서버 주소 칸 모양으로 돌려줌
// 폼 창 대신 떴다가 고르면 돌아감 (두 창이 겹치면 Esc가 둘 다 닫아서). big = 새 디자인 창(Dialog)으로 (03 주문, 11/04)
// 초성 · 최근 검색은 안 붙임: 검색칸이 카카오 화면 안(iframe)이고, 주소는 개인정보라 최근 목록에 남기지 않음

/** 고른 주소 — 서버 주소의 필수 칸(위도 · 경도 빼고). 좌표는 쓰는 쪽에서 */
export interface SearchedAddress {
  roadAddress: string
  jibunAddress: string
  dongName: string
  postalCode: string // 5자리 문자열 (앞 0 보존)
}
