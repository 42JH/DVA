// 사이드바 메뉴 (10/20 확정). 경로 = 라우터(app/App.tsx)와 같아야 함
// (컴포넌트 파일과 분리: Fast Refresh는 컴포넌트만 export하는 파일을 요구)
export const MENU: { to: string; label: string; subs?: { to: string; label: string }[] }[] = [
  { to: '/', label: '홈' },
  { to: '/dashboard', label: '대시보드' },
  {
    to: '/orders',
    label: '상세내역',
    subs: [
      { to: '/orders', label: '주문 내역' },
      { to: '/calls', label: '통화 내역' },
      { to: '/inquiries', label: '통화 문의' },
    ],
  },
  { to: '/companies', label: '기업관리' },
  { to: '/personas', label: '페르소나 관리' },
  { to: '/faqs', label: 'FAQ 관리' },
  { to: '/admins', label: '관리자 권한 관리' },
  { to: '/me', label: '내 정보' },
]
