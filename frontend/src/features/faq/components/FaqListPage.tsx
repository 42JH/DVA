import { useState } from 'react'
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { fmtDateTime } from '@/shared/lib/format'
import { useRememberView } from '@/shared/lib/recentViews'
import { unansweredTo } from '@/shared/lib/unansweredReason'
import { useSlideDir } from '@/shared/lib/useSlideDir'
import {
  BAR_COLS,
  Button,
  ConfirmDialog,
  Highlight,
  Markdown,
  Pagination,
  TopBar,
} from '@/shared/ui'
import { useFaqDelete, useFaqForm } from '@/features/faq/hooks/useFaqForm'
import {
  FAQ_CATEGORIES,
  faqTo,
  useFaqList,
  useFaqOpenTo,
  useRecentQuestions,
  type Faq,
  type FaqCategory,
} from '@/features/faq/hooks/useFaqList'
import { useUnansweredCount, type UnansweredQuestion } from '@/features/faq/hooks/useUnansweredList'
import { Icon } from './icons'

// 09 FAQ (Figma 'FAQ' · 'FAQ 수정' · 'FAQ 등록' 11/06) — 한 화면에서 보기 · 추가 · 수정 · 삭제 (상세 · 작성 · 수정 화면은 없어짐)
// 상단바 세 칸과 같은 열: 왼쪽 분류(고른 것 = 옅은 하늘 바탕) | 가운데 'Q 질문' 줄(18, 검색칸 아래로 줄 맞춤) | 오른쪽 빈칸
// 질문을 누르면 그 자리에서 답변(회색 상자) + 연필 · 휴지통, 그 아래 이 FAQ로 AI가 답한 최근 고객 질문(누르면 원본 통화, 11/06 사용자)
// 연필 = 그 줄이 질문칸(밑줄) + 답변칸(선 상자) + 취소 · 저장. [추가] = 목록 맨 위에 빈 칸 (분류 = 왼쪽에서 고른 것)
// 아래: 왼쪽 '답변 대기 →'(AI 미답변 문의 — 예전 상단바 알림 자리) · 가운데 쪽 번호 · 오른쪽 [추가]
// 검색은 상단바 공용 탭 검색(FAQ 탭, Enter는 이 목록에) — 검색 중엔 왼쪽 위 'FAQ > “박스” 검색', 고른 분류 없음, 맞은 자리 하이라이트
// AI 미답변 [+]로 오면(state.from) 맨 위 추가 칸에 고객이 한 말을 채워 둠 → 저장(그 질문 처리됨) · 취소 모두 보던 미답변 목록으로
// 한 화면에: 질문 줄만 스크롤 (상단바 · 쪽 번호는 고정)
export function FaqListPage() {
  const vm = useFaqList()
  const navigate = useNavigate()
  const { pathname, search, state } = useLocation()
  const st = state as { from?: UnansweredQuestion; back?: string } | null
  const [adding, setAdding] = useState<{ from?: UnansweredQuestion; back?: string } | null>(
    st?.from ? { from: st.from, back: st.back ?? '/faqs/unanswered' } : null,
  )
  const [editing, setEditing] = useState<number | null>(null)
  const waiting = useUnansweredCount()
  const changed = useSlideDir(FAQ_CATEGORIES.findIndex((c) => c.name === vm.category)) !== 0
  const slide = changed ? 'motion-safe:animate-slide-in-u' : ''

  const closeAdd = () => (adding?.back ? navigate(adding.back) : setAdding(null))

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar
        wide
        crumbs={vm.q ? [{ label: 'FAQ', to: vm.listTo }, { label: `“${vm.q}” 검색` }] : undefined}
        search={{ tab: 'faq', q: vm.q, onApply: vm.setQ }}
      />

      <div className={`${BAR_COLS} min-h-0 flex-[1_1_0px] grid-rows-[minmax(0,1fr)_auto] pt-v28`}>
        <CategoryNav value={vm.category} />
        <div className="min-h-0 [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] overflow-y-auto pb-2">
          {/* 추가 칸은 분류를 바꿔도 남음 (쓰던 글 그대로, 분류만 따라감) — 그래서 다시 그려지는 질문 목록 밖에 */}
          {adding && (
            <div className="mb-v32">
              <FaqEditor
                from={adding.from}
                category={vm.addCategory}
                onCancel={closeAdd}
                onSaved={closeAdd}
              />
            </div>
          )}
          <ul key={vm.category ?? 'search'} className={`flex flex-col gap-v32 ${slide}`}>
            {vm.rows.map((f) => (
              <li key={f.faqEntrySeq}>
                {editing === f.faqEntrySeq ? (
                  <FaqEditor
                    faq={f}
                    onCancel={() => setEditing(null)}
                    onSaved={() => setEditing(null)}
                  />
                ) : (
                  <FaqRow
                    faq={f}
                    q={vm.q}
                    open={vm.open === f.faqEntrySeq}
                    onToggle={() => vm.toggle(f.faqEntrySeq)}
                    onEdit={() => setEditing(f.faqEntrySeq)}
                  />
                )}
              </li>
            ))}
            {!vm.rows.length && !adding && (
              <li className="text-body text-sub">
                {vm.isLoading
                  ? '불러오는 중…'
                  : (vm.error ?? (vm.q ? '해당하는 FAQ가 없습니다.' : '이 분류에 FAQ가 없습니다.'))}
              </li>
            )}
          </ul>
        </div>

        <Link
          to={unansweredTo(pathname + search)}
          className="col-start-1 row-start-2 flex items-center gap-2 self-center text-body font-medium text-sub hover:text-ink"
        >
          답변 대기{waiting > 0 && <span className="text-danger tabular-nums">{waiting}</span>}
          <Icon name="arrow" className="size-5" />
        </Link>
        <div className="col-start-2 row-start-2 pt-4">
          <Pagination big page={vm.page} pages={vm.pages} onChange={vm.goPage} />
        </div>
        <Button
          kind="brand"
          big
          className="col-start-3 row-start-2 self-center justify-self-end"
          onClick={() => {
            vm.startAdd()
            setEditing(null)
            setAdding((a) => a ?? {})
          }}
        >
          추가
        </Button>
      </div>
    </div>
  )
}

/** 옛 상세 주소 /faqs/:id(?q=) — 검색 창 · 최근 조회 · 다른 화면 링크. 그 FAQ를 펼친 목록으로 바꿔 감 */
export function FaqOpenRedirect() {
  const id = Number(useParams().faqId)
  const q = useSearchParams()[0].get('q') ?? ''
  const to = useFaqOpenTo(id, q)
  return to ? (
    <Navigate to={to} replace />
  ) : (
    <p className="pt-v84 text-body text-sub">불러오는 중…</p>
  )
}

/** 왼쪽 분류 — 누르면 그 분류 목록 (Figma 160 × 48 칸 · 20/500, 고른 것 = 옅은 하늘 바탕). value null = 고른 분류 없음(검색 중) */
function CategoryNav({ value }: { value: FaqCategory | null }) {
  return (
    <nav aria-label="분류" className="flex min-h-0 flex-col items-start gap-1">
      {FAQ_CATEGORIES.map(({ name }) => (
        <Link
          key={name}
          to={faqTo.list(name)}
          aria-current={value === name ? 'true' : undefined}
          className={`flex h-[clamp(34px,5.333dvh,48px)] w-40 shrink-0 items-center rounded px-5 text-card font-medium ${value === name ? 'bg-frame' : 'hover:bg-bg'}`}
        >
          {name}
        </Link>
      ))}
    </nav>
  )
}

const ICON_BTN = 'grid size-7 place-items-center rounded text-sub hover:bg-bg hover:text-ink'

/** 'Q 질문' 한 줄 — 누르면 답변이 펼쳐지고 접힘. 펼친 줄은 질문 옆에 연필 · 휴지통 */
function FaqRow({
  faq,
  q,
  open,
  onToggle,
  onEdit,
}: {
  faq: Faq
  q: string
  open: boolean
  onToggle: () => void
  onEdit: () => void
}) {
  const del = useFaqDelete(faq, () => undefined)
  return (
    <>
      <div className="flex items-center gap-4">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="group flex min-w-0 gap-4 text-left text-strong"
        >
          <span aria-hidden>Q</span>
          <span className={`min-w-0 group-hover:text-brand ${open ? 'break-words' : 'truncate'}`}>
            <Highlight text={faq.question} q={q} />
          </span>
        </button>
        {open && (
          <span className="flex shrink-0 gap-1">
            <button
              type="button"
              aria-label="수정"
              title="수정"
              onClick={onEdit}
              className={ICON_BTN}
            >
              <Icon name="edit" className="size-5" />
            </button>
            <button
              type="button"
              aria-label="삭제"
              title="삭제"
              onClick={del.ask}
              className={ICON_BTN}
            >
              <Icon name="trash" className="size-5" />
            </button>
          </span>
        )}
      </div>
      {open && <FaqAnswer faq={faq} q={q} />}
      {del.confirming && (
        <ConfirmDialog
          big
          title="정말로 삭제하시겠습니까?"
          target={del.target}
          warn={del.error ?? undefined}
          okLabel="삭제"
          pending={del.pending}
          onOk={del.confirm}
          onClose={del.cancel}
        />
      )}
    </>
  )
}

/** 펼친 답변(회색 상자 · 마크다운) + 이 FAQ로 AI가 답한 최근 고객 질문 (GET /faqs/{id}의 recentQuestions — 최신순 최대 10, 발화 원문 그대로)
 *  원본 통화 번호가 있으면 질문을 누르면 통화 상세, 없으면(원본 삭제 · 만료) 글만 */
function FaqAnswer({ faq, q }: { faq: Faq; q: string }) {
  const id = faq.faqEntrySeq
  useRememberView('faq', id, { label: faq.question }) // 검색 창 '최근 조회'
  const questions = useRecentQuestions(id)
  return (
    <div className="mt-4 ml-7.5 flex flex-col gap-4">
      <Markdown text={faq.answer} highlight={q} className="rounded bg-bg p-4 text-body" />
      {questions.length > 0 && (
        <ul aria-label="이 FAQ로 답한 최근 고객 질문" className="flex flex-col gap-2 px-1">
          {questions.map((qe) => (
            <li
              key={qe.faqQuestionExampleSeq}
              className="flex items-start gap-2 text-label text-sub"
            >
              <svg
                viewBox="0 0 16 16"
                className="mt-[2px] size-4 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 8.7981 2.15582 9.5598 2.43871 10.2563C2.49285 10.3897 2.51992 10.4563 2.532 10.5102C2.54381 10.5629 2.54813 10.6019 2.54814 10.6559C2.54814 10.7111 2.53812 10.7713 2.51807 10.8916L2.12275 13.2635C2.08135 13.5119 2.06065 13.6361 2.09917 13.7259C2.13289 13.8045 2.19552 13.8671 2.27412 13.9008C2.36393 13.9393 2.48812 13.9186 2.73651 13.8772L5.10843 13.4819C5.22872 13.4619 5.28887 13.4519 5.34409 13.4519C5.3981 13.4519 5.43711 13.4562 5.48981 13.468C5.54369 13.4801 5.61035 13.5072 5.74366 13.5613C6.4402 13.8442 7.2019 14 8 14Z" />
              </svg>
              {qe.callSessionSeq !== null ? (
                // 원본 통화로 (통화 상세가 404면 그 화면이 이 FAQ 고객 질문을 다시 받게 fromFaq를 넘김)
                <Link
                  to={`/calls/${qe.callSessionSeq}`}
                  state={{ fromFaq: id }}
                  title="이 질문이 나온 통화 보기"
                  className="min-w-0 break-words whitespace-pre-wrap hover:text-brand hover:underline"
                >
                  {qe.questionText}
                </Link>
              ) : (
                <span
                  title="통화 원본이 삭제되어 조회할 수 없습니다"
                  className="min-w-0 break-words whitespace-pre-wrap"
                >
                  {qe.questionText}
                </span>
              )}
              <span className="ml-auto shrink-0 pl-4 text-caption text-muted tabular-nums">
                {fmtDateTime(qe.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 추가 · 수정 칸 (Figma 'FAQ 등록' · 'FAQ 수정') — 'Q 질문칸'(밑줄) · 답변칸(선 상자, 글 길이만큼 늘어남) · 오류 | 취소 · 저장 */
function FaqEditor({
  faq,
  from,
  category,
  onCancel,
  onSaved,
}: {
  faq?: Faq
  from?: UnansweredQuestion
  category?: FaqCategory
  onCancel: () => void
  onSaved: () => void
}) {
  const vm = useFaqForm({ faq, from, category, onSaved })
  return (
    <div>
      <div className="flex items-center gap-4 text-strong">
        <span aria-hidden>Q</span>
        <input
          aria-label="질문"
          autoFocus
          maxLength={1000}
          value={vm.question}
          onChange={(e) => vm.setQuestion(e.target.value)}
          placeholder="질문 제목을 입력해주세요"
          className="min-w-0 flex-1 border-b border-line bg-transparent pb-2 outline-none placeholder:text-field focus:border-brand"
        />
      </div>
      <textarea
        aria-label="답변"
        maxLength={20000}
        value={vm.answer}
        onChange={(e) => vm.setAnswer(e.target.value)}
        placeholder="답변을 입력해주세요"
        className="mt-3 ml-7.5 block [field-sizing:content] max-h-[40dvh] min-h-14 w-[calc(100%-30px)] resize-none rounded border border-field bg-transparent p-4 text-body outline-none placeholder:text-field focus:border-brand"
      />
      <div className="mt-3 flex items-center gap-4 pl-7.5 text-body font-medium">
        <p role="alert" className="min-w-0 flex-1 text-label text-danger">
          {vm.error}
        </p>
        <button type="button" onClick={onCancel} className="text-muted hover:text-ink">
          취소
        </button>
        <button
          type="button"
          disabled={!vm.canSubmit}
          onClick={vm.submit}
          className="text-brand hover:underline disabled:text-muted disabled:no-underline"
        >
          저장
        </button>
      </div>
    </div>
  )
}
