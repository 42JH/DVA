// 사이드바 메뉴 (10/20 확정 · 10/28 05 통화 문의 삭제 · FAQ 관리 ▸ FAQ 목록 · AI 미답변). 경로 = 라우터(app/router.tsx)와 같아야 함
// (컴포넌트 파일과 분리: Fast Refresh는 컴포넌트만 export하는 파일을 요구)
export type MenuIcon =
  'home' | 'chart' | 'list' | 'building' | 'sliders' | 'faq' | 'shield' | 'user' | 'logout'

export const MENU: {
  to: string
  label: string
  icon: MenuIcon
  subs?: { to: string; label: string }[]
}[] = [
  { to: '/', label: '홈', icon: 'home' },
  { to: '/dashboard', label: '대시보드', icon: 'chart' },
  {
    to: '/orders',
    label: '상세내역',
    icon: 'list',
    subs: [
      { to: '/orders', label: '주문 내역' },
      { to: '/calls', label: '통화 내역' },
    ],
  },
  { to: '/companies', label: '기업관리', icon: 'building' },
  { to: '/personas', label: '페르소나 관리', icon: 'sliders' },
  {
    to: '/faqs',
    label: 'FAQ 관리',
    icon: 'faq',
    subs: [
      { to: '/faqs', label: 'FAQ 목록' },
      { to: '/faqs/unanswered', label: 'AI 미답변' },
    ],
  },
  { to: '/admins', label: '관리자 권한 관리', icon: 'shield' },
  { to: '/me', label: '내 정보', icon: 'user' },
]
