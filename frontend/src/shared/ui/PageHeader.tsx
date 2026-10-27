// 상단바 (와이어프레임 16 Page header) — 높이 64 · 제목 28/700 · 아래 구분선 · 왼쪽 여백 32(본문과 같은 선)
// 사이드바처럼 모든 화면에 고정된 틀이라 각 화면이 그리지 않는다. AppLayout이 라우트의 handle.title로 그린다
export function PageHeader({ title }: { title: string }) {
  return (
    <header className="flex h-16 shrink-0 items-center border-b border-line px-content">
      <h1 className="text-title font-bold">{title}</h1>
    </header>
  )
}
