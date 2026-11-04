import { Link } from 'react-router'

// 상단바 (와이어프레임 16 Page header) — 높이 64 · 제목 28/700 · 아래 구분선 · 왼쪽 여백 32(본문과 같은 선)
// 사이드바처럼 모든 화면에 고정된 틀이라 각 화면이 그리지 않는다. AppLayout이 라우트의 handle.title로 그린다
// 오른쪽 끝 = AI 미답변 알림 (Figma '프레임' 11/04 — 사이드바 'AI 미답변' 옆 빨간 숫자가 여기로). 0건이면 안 보임
// 종 20 + 8 + 글자 16/600. 색은 디자인(#e77f83)이 흰 바탕에서 대비 2.7:1이라 danger(빨강)로
export function PageHeader({ title, unanswered }: { title: string; unanswered: number }) {
  return (
    <header className="flex h-16 shrink-0 items-center border-b border-line px-content">
      <h1 className="text-title font-bold">{title}</h1>
      {unanswered > 0 && (
        <Link
          to="/faqs/unanswered"
          className="ml-auto flex items-center gap-2 text-body font-semibold text-danger hover:underline"
        >
          <svg
            viewBox="0 0 20 20"
            className="size-5 shrink-0"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M7.77778 16.7424C8.36751 17.2135 9.14627 17.5 10 17.5C10.8537 17.5 11.6325 17.2135 12.2222 16.7424M3.75636 14.3182C3.40502 14.3182 3.20878 13.7662 3.42131 13.4595C3.91447 12.7479 4.39046 11.7043 4.39046 10.4475L4.4108 8.62638C4.4108 5.24288 6.91317 2.5 10 2.5C13.1323 2.5 15.6715 5.28328 15.6715 8.71662L15.6512 10.4475C15.6512 11.7129 16.1108 12.7623 16.5839 13.4742C16.7882 13.7816 16.5914 14.3182 16.2444 14.3182H3.75636Z" />
          </svg>
          AI 상담가가 답변하지 못한 문의가 {unanswered}건 있습니다
        </Link>
      )}
    </header>
  )
}
