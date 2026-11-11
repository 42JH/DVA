// 버튼 모양 (11/11 사용자: 상태 칩과 버튼이 같은 모양이라 헷갈림 — Figma '버튼 · 칩 모양 정리')
//   연한 채움 = 상태(Badge, 못 누름) · 흰 바탕 + 테두리 = 버튼 · 진한 채움 = 만들기 · 등록 · 저장 · 확정(크기 · 자리와 상관없이 같은 모양, 11/11)
//   색 = 뜻: 파랑 만들기 · 저장 · 승인, 노랑 수정 · 설정, 빨강 삭제 · 되돌릴 수 없음, 회색 닫기 · 취소 · 보기 · 이동
// 테두리는 안쪽 ring — 테두리 있는 버튼과 없는 버튼의 폭 · 글자 자리가 같게
export const ACTION_BADGE_SIZE =
  'inline-flex h-[22px] items-center justify-center rounded px-1.5 text-[12px] font-medium'

export const BUTTON_LOOK = {
  solid: 'bg-ops-route text-white hover:bg-[#1a5fcc]',
  solidDanger: 'bg-ops-stop text-white hover:bg-[#c22f2f]',
  line: 'bg-white text-ops-route ring-1 ring-[#8fb6f5] ring-inset hover:bg-ops-route-soft',
  edit: 'bg-white text-ops-wait ring-1 ring-[#e3b56b] ring-inset hover:bg-ops-wait-soft',
  danger: 'bg-white text-ops-stop ring-1 ring-[#ec9c9c] ring-inset hover:bg-ops-stop-soft',
  plain: 'bg-white text-ops-ink ring-1 ring-[#c5ccd6] ring-inset hover:bg-ops-paper',
}
