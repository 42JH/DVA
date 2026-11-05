import { Link, useNavigate } from 'react-router'
import { useSlideDir } from '@/shared/lib/useSlideDir'
import { Button, Crumbs, Highlight, Pagination, TopBar } from '@/shared/ui'
import { FAQ_CATEGORIES, faqTo, useFaqList } from '@/features/faq/hooks/useFaqList'
import { FAQ_GRID, FaqCategoryNav } from './FaqCategories'

// 09 FAQ 목록 (Figma 디자인/목업 'FAQ' 11/04) — 상단바(날짜 · 검색 · AI 미답변 알림)
// 왼쪽 분류(고른 것 파랑) · 오른쪽 'Q 질문' 줄(24, 줄 간격 61, 누르면 상세) · 첫 줄 오른쪽 [추가] · 맨 아래 가운데 쪽 번호
// 검색어가 있으면 모든 분류에서 찾고 왼쪽은 고른 분류 없음 (useFaqList). 검색은 상단바 공용 탭 검색(FAQ 탭이 먼저, Enter는 이 목록에)
// 검색 중엔 상단바 아래 경로가 'FAQ > “박스” 검색', 질문의 맞은 자리 하이라이트, 상세로 갈 때 검색어를 달고 감 (11/04 사용자)
// 분류를 바꾸면 질문 목록이 늘 아래에서 위로 올라옴 (11/04 사용자). 화면에 처음 들어올 땐 페이지 전환만
export function FaqListPage() {
  const vm = useFaqList()
  const navigate = useNavigate()
  const changed = useSlideDir(FAQ_CATEGORIES.findIndex((c) => c.name === vm.category)) !== 0
  const slide = changed ? 'motion-safe:animate-slide-in-u' : ''

  return (
    <>
      <TopBar search={{ tab: 'faq', q: vm.q, onApply: vm.setQ }} />
      {/* 경로는 상단바 아래 줄 (11/05 사용자: 모든 화면 같은 상단바) — 검색 중엔 'FAQ > “박스” 검색' */}
      <Crumbs
        items={
          vm.q ? [{ label: 'FAQ', to: vm.listTo }, { label: `“${vm.q}” 검색` }] : [{ label: 'FAQ' }]
        }
        className="shrink-0 pl-17"
      />

      <div className={`${FAQ_GRID} pt-v76`}>
        <FaqCategoryNav value={vm.category} />
        <div className="flex min-w-0 items-start gap-6 pl-5">
          <div key={vm.category ?? 'search'} className={`min-w-0 flex-1 ${slide}`}>
            {vm.rows.length ? (
              <ul className="flex flex-col gap-v28">
                {vm.rows.map((f) => (
                  <li key={f.faqEntrySeq}>
                    {/* 누르는 곳은 'Q 질문' 글자만 (줄 오른쪽 빈 곳은 안 눌림 — 11/04 사용자: 클릭 범위가 너무 넓음) */}
                    <Link
                      to={faqTo.detail(f.faqEntrySeq, vm.q)}
                      className="group inline-flex max-w-full gap-5 text-v24"
                    >
                      <span aria-hidden className="text-muted">
                        Q
                      </span>
                      <span className="min-w-0 truncate group-hover:text-brand">
                        <Highlight text={f.question} q={vm.q} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-body text-sub">
                {vm.isLoading
                  ? '불러오는 중…'
                  : (vm.error ?? (vm.q ? '해당하는 FAQ가 없습니다.' : '이 분류에 FAQ가 없습니다.'))}
              </p>
            )}
          </div>
          <Button kind="brand" big onClick={() => navigate(vm.addTo)}>
            추가
          </Button>
        </div>
      </div>

      <div className="mt-auto pt-6">
        <Pagination big page={vm.page} pages={vm.pages} onChange={vm.goPage} />
      </div>
    </>
  )
}
