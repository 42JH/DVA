import type { ReactNode } from 'react'

/** 목록 화면 뼈대 (11/02 사용자: 정렬 · 여백은 화면마다 따로 두지 않는다 — 디자인 · 요소가 바뀌어도 남는 틀)
 *
 *  <ListPage>                       세로 간격 24: 탭 → 필터 줄 → (안내 · 칩) → 표 카드
 *    <Tabs … />
 *    <FilterBar>                    가로 간격 12 · 세로 가운데: 검색칸(min-w-0 flex-1) · 날짜 칸 · 셀렉트 · 버튼(tall)
 *      <SearchBox className="min-w-0 flex-1" … /> <DateField … /> <Button tall>…</Button>
 *    </FilterBar>
 *    <Table … />
 *  </ListPage>
 *
 *  03 · 04 · 08 · 09 · 10이 쓰고, 02도 세로 간격만 같이 씀. 여백 값을 바꾸려면 여기 한 곳
 *  가로 규칙: 상자(카드 · 입력칸 · 표)는 본문 가장자리에 딱, 상자 밖 글(탭 · 칩 줄 · 안내 · 오류)은 px-4 = 입력칸 안 글자 시작선 */
export function ListPage({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`flex flex-col gap-6 ${className}`}>{children}</div>
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-3">{children}</div>
}
