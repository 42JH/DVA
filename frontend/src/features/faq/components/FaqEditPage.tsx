import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { Button, ConfirmDialog, Crumbs } from '@/shared/ui'
import { useFaqForm } from '@/features/faq/hooks/useFaqForm'
import {
  faqTo,
  isCategory,
  useFaqDetail,
  type Faq,
  type FaqCategory,
} from '@/features/faq/hooks/useFaqList'
import { unansweredCrumbs } from '@/shared/lib/unansweredReason'
import type { UnansweredQuestion } from '@/features/faq/hooks/useUnansweredList'
import { FAQ_GRID, FaqCategoryPicker } from './FaqCategories'

// 09 FAQ 작성 · 수정 (Figma 'FAQ 등록' · 'FAQ 수정' 11/04) — /faqs/new · /faqs/:faqId/edit 한 화면
// 왼쪽 상자 = 분류 고르기, 오른쪽 상자 = 질문(28/500) | 선 | 답변(24). 아래 [삭제](수정만, 왼쪽) · [취소](회색) [저장](파랑)
// 작성은 목록에서 보던 분류를 골라 둔 채로(?category=). 저장하면 작성 → 그 분류 목록(새 FAQ가 맨 위), 수정 → 상세
// 검색해서 온 수정(?q=)은 경로 'FAQ > “박스” 검색 > “박스” 검색 상세 > FAQ 수정', 저장 · 취소 → 그 상세, 삭제 → 그 검색 결과
// AI 미답변 [FAQ 추가]로 온 작성(state.from, 11/05): 질문 칸 = 고객이 한 말, 경로 '[이동 전 화면] > AI 미답변 > FAQ 작성'
//   저장하면 FAQ가 생기고 그 질문은 처리됨(API-27) → 저장 · 취소 모두 보던 미답변 목록(state.back)으로
export function FaqEditPage() {
  const { faqId } = useParams()
  const [sp] = useSearchParams()
  const q = sp.get('q') ?? ''
  const detail = useFaqDetail(Number(faqId))
  const st = useLocation().state as { from?: UnansweredQuestion; back?: string } | null

  if (!faqId) {
    const c = sp.get('category')
    return (
      <FaqForm
        faq={null}
        category={isCategory(c) ? c : undefined}
        from={st?.from}
        fromBack={st?.back ?? '/faqs/unanswered'}
      />
    )
  }
  if (!detail.faq)
    return (
      <>
        <Crumbs
          items={[
            { label: 'FAQ', to: '/faqs' },
            { label: 'FAQ 상세', to: `/faqs/${faqId}` },
            { label: 'FAQ 수정' },
          ]}
          className="pl-17"
        />
        <p className="pt-v84 pl-17 text-body text-sub">
          {detail.isLoading
            ? '불러오는 중…'
            : (detail.error ?? '없는 FAQ입니다. 이미 지워졌을 수 있어요.')}
        </p>
      </>
    )
  return <FaqForm key={faqId} faq={detail.faq} q={q} />
}

function FaqForm({
  faq,
  category,
  q = '',
  from,
  fromBack = '/faqs/unanswered',
}: {
  faq: Faq | null
  category?: FaqCategory
  q?: string
  from?: UnansweredQuestion // AI 미답변에서 옴 — 이 질문을 FAQ로
  fromBack?: string // 그때 돌아갈 미답변 목록 주소 (검색 · 사유 · 쪽 그대로)
}) {
  const navigate = useNavigate()
  const vm = useFaqForm({
    faq,
    from,
    category,
    onSaved: (c) =>
      navigate(from ? fromBack : faq ? faqTo.detail(faq.faqEntrySeq, q) : faqTo.list(c)),
    onDeleted: (c) => navigate(q ? faqTo.search(q) : faqTo.list(c)),
  })
  const back = from ? fromBack : faq ? faqTo.detail(faq.faqEntrySeq, q) : faqTo.list(category)
  const error = vm.categoryError ?? vm.questionError ?? vm.answerError ?? vm.errorMessage

  return (
    <>
      <Crumbs
        items={
          from
            ? [...unansweredCrumbs(fromBack), { label: 'FAQ 작성' }] // '[이동 전 화면] > AI 미답변 > FAQ 작성'
            : !faq
              ? [{ label: 'FAQ', to: back }, { label: 'FAQ 작성' }]
              : q
                ? [
                    { label: 'FAQ', to: faqTo.list(faq.category) },
                    { label: `“${q}” 검색`, to: faqTo.search(q) },
                    { label: `“${q}” 검색 상세`, to: back },
                    { label: 'FAQ 수정' },
                  ]
                : [
                    { label: 'FAQ', to: faqTo.list(faq.category) },
                    { label: 'FAQ 상세', to: back },
                    { label: 'FAQ 수정' },
                  ]
        }
        className="pl-17"
      />

      <div
        className={`${FAQ_GRID} mb-v44 min-h-80 flex-1 grid-rows-[minmax(0,1fr)_auto] gap-y-6 pt-v84`}
      >
        <FaqCategoryPicker value={vm.category} onChange={vm.setCategory} />
        <div className="flex min-w-0 flex-col rounded-xl border border-line focus-within:border-brand">
          <input
            aria-label="질문"
            maxLength={1000}
            value={vm.question}
            onChange={(e) => vm.setQuestion(e.target.value)}
            placeholder="질문을 입력해주세요"
            className="h-v76 shrink-0 border-b border-line bg-transparent px-5 text-v28 font-medium outline-none placeholder:text-muted"
          />
          <textarea
            aria-label="답변"
            maxLength={20000}
            value={vm.answer}
            onChange={(e) => vm.setAnswer(e.target.value)}
            placeholder="답변 내용을 작성해주세요"
            className="min-h-0 flex-1 resize-none bg-transparent px-5 py-6 text-v24 outline-none placeholder:text-muted"
          />
        </div>
        <div className="col-start-2 flex items-center gap-5">
          {faq && (
            <Button kind="dangerLine" big onClick={vm.askDelete}>
              삭제
            </Button>
          )}
          <p role="alert" className="min-w-0 flex-1 text-label font-semibold text-danger">
            {error}
          </p>
          <Button kind="gray" big onClick={() => navigate(back)}>
            취소
          </Button>
          <Button kind="brand" big disabled={!vm.canSubmit} onClick={vm.submit}>
            저장
          </Button>
        </div>
      </div>

      {vm.confirmingDelete && (
        <ConfirmDialog
          title="정말로 삭제하시겠습니까?"
          target={vm.deleteTarget}
          warn={vm.deleteError ?? undefined}
          okLabel="삭제"
          pending={vm.isDeleting}
          onOk={vm.confirmDelete}
          onClose={vm.cancelDelete}
        />
      )}
    </>
  )
}
