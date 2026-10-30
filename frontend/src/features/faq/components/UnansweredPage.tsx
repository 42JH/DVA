import { AppliedFilters, Pagination, SearchBox } from '@/shared/ui'
import { useUnansweredList } from '@/features/faq/hooks/useUnansweredList'
import { UnansweredTable } from './UnansweredTable'

// 09 AI 미답변 (와이어프레임 09_AI미답변 · _FAQ추가 · _삭제확인, 10/30) — 탭 줄 없음, 맨 윗줄 = 검색
// 카드 'AI 미답변 질문 n개' · 오래된 순. 표 · 창은 UnansweredTable (01 홈 미리보기와 같이 씀)
// 06 '처리 내용 › AI 미답변 보기'로 오면 그 통화의 질문만 + 검색칸 아래 '적용된 필터' 칩 (✕ = 전체 미답변으로)
export function UnansweredPage() {
  const vm = useUnansweredList()

  return (
    <div className="flex flex-col gap-6">
      <SearchBox
        value={vm.q}
        onChange={vm.setQ}
        recentKey="unanswered"
        suggestions={vm.suggestions}
        placeholder="질문 · 이름 · 전화번호"
      />
      <AppliedFilters chips={vm.callChips} onRemove={vm.clearCall} onClear={vm.clearCall} />

      <UnansweredTable
        vm={vm}
        head={
          <h2 className="flex items-baseline gap-3.5 text-card font-bold">
            AI 미답변 질문
            <span className="text-label font-normal text-sub">{vm.count}개</span>
          </h2>
        }
        empty={vm.q ? '해당하는 질문이 없습니다.' : 'AI가 답하지 못한 질문이 없습니다.'}
        footer={<Pagination page={vm.page} pages={vm.pages} onChange={vm.goPage} />}
      />
    </div>
  )
}
