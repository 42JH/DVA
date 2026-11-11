// FAQ (11/06) — 왼쪽 분류(건수) | 가운데 질문 목록(누르면 펼쳐 답변 · 고객 질문 사례 · 수정 · 삭제) · 맨 위 추가 칸
// 기업 피드백: 아코디언 유지 · 실제 통화 발화와 연결(사례를 누르면 그 통화)
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Markdown } from '@/shared/ui/Markdown'
import type { Faq, FaqCategory } from '@/features/faq/api/faqApi'
import { Choice } from '@/shared/ui/Field'
import type { UnansweredQuestion } from '@/features/faq/api/unansweredApi'
import { useFaqDelete, useFaqForm } from '@/features/faq/hooks/useFaqForm'
import { PageHead } from '@/shared/ui'
import { Btn, Icon } from '@/shared/ui'
import { SearchBox } from '@/shared/ui/ListFrame'
import { useExamples, useFaqs, type FaqsVm } from '../hooks/useFaqs'
import { useEffect, useRef, useState } from 'react'
import { useKeepScroll } from '@/shared/lib/keepScroll'

/** 2026.11.07 */
const ymd = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${two(d.getMonth() + 1)}.${two(d.getDate())}`
}
import { Confirm } from '@/shared/ui/Modal'

export function FaqsPage() {
  const vm = useFaqs()
  const box = useRef<HTMLElement>(null)
  useKeepScroll(box, 'list')
  return (
    <>
      <PageHead title="FAQ">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="질문, 답변으로 검색"
          label="FAQ 검색"
        />
        <Btn kind="primary" className="ml-auto" onClick={vm.startAdd} disabled={vm.adding}>
          <Icon name="plus" />
          FAQ 등록
        </Btn>
      </PageHead>
      <section
        ref={box}
        aria-label="FAQ 목록"
        className="min-h-0 min-w-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-6 py-4"
      >
        <div className="flex min-h-full flex-col gap-3">
          <nav
            aria-label="FAQ 분류"
            className="flex [scrollbar-width:none] gap-1.5 overflow-x-auto [&::-webkit-scrollbar]:hidden"
          >
            <Cat
              on={!vm.cat && !vm.q}
              onClick={() => vm.setCat(null)}
              label="전체"
              count={vm.total}
            />
            {vm.cats.map((c) => (
              <Cat
                key={c.name}
                on={vm.cat === c.name && !vm.q}
                onClick={() => vm.setCat(c.name)}
                label={c.name}
                count={c.count}
              />
            ))}
          </nav>
          {vm.adding && (
            <FaqForm
              category={vm.addCategory}
              from={vm.from}
              onDone={vm.finishAdd}
              title={vm.from ? '미답변 질문으로 FAQ 만들기' : '새 FAQ'}
            />
          )}
          {vm.q && (
            <p className="text-[13px] text-ops-sub">
              “{vm.q}” 검색 결과 {vm.rows.length}건
            </p>
          )}
          {vm.rows.map((f) => (
            <Item key={f.faqEntrySeq} f={f} vm={vm} />
          ))}
          {vm.rows.length === 0 && (
            <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
              {vm.isLoading
                ? '불러오는 중…'
                : (vm.error ??
                  (vm.q ? '검색어에 맞는 FAQ가 없습니다.' : '이 분류에 FAQ가 없습니다.'))}
            </p>
          )}
        </div>
      </section>
    </>
  )
}

function Cat({
  on,
  onClick,
  label,
  count,
}: {
  on: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={on || undefined}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap ${on ? 'bg-[#6b6b6b] text-white' : 'bg-ops-idle-soft text-ops-sub hover:bg-[#dfe2e8] hover:text-ops-ink'}`}
    >
      <span># {label}</span>
      <span className={`text-[12px] tabular-nums ${on ? 'text-white/70' : 'text-ops-faint'}`}>
        {count}
      </span>
    </button>
  )
}

function Item({ f, vm }: { f: Faq; vm: FaqsVm }) {
  const open = vm.open === f.faqEntrySeq
  const [editing, setEditing] = useState(false)
  if (editing)
    return (
      <FaqForm faq={f} category={f.category} onDone={() => setEditing(false)} title="FAQ 수정" />
    )
  return (
    <article
      className={`rounded-lg border bg-white ${open ? 'border-ops-route/40' : 'border-ops-line'}`}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => vm.toggle(f.faqEntrySeq)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ops-route"
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="inline-flex h-[22px] shrink-0 items-center rounded bg-ops-route-soft px-1.5 text-[12px] font-medium text-ops-route">
            {f.category}
          </span>
          <span className="truncate text-[15px] font-semibold">{f.question}</span>
        </span>
        <Icon
          name="chevron"
          className={`size-4 self-center text-ops-faint transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <Collapsible open={open}>
        <Opened f={f} open={open} onEdit={() => setEditing(true)} />
      </Collapsible>
    </article>
  )
}

/** 열고 닫을 때 slide up/down — 내용 높이를 측정해 inline maxHeight로 바로 애니메이션 */
function Collapsible({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [h, setH] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setH(el.scrollHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children])
  return (
    <div
      style={{ maxHeight: open ? h : 0 }}
      className="overflow-hidden transition-[max-height] duration-200 ease-out"
    >
      <div ref={ref}>{children}</div>
    </div>
  )
}

function Opened({ f, open, onEdit }: { f: Faq; open: boolean; onEdit: () => void }) {
  const examples = useExamples(f.faqEntrySeq, open)
  const del = useFaqDelete(f, () => undefined)
  return (
    <div className="border-t border-ops-line px-4 pt-3 pb-4">
      <div className="rounded-md bg-ops-paper px-4 py-3">
        <Markdown text={f.answer} className="text-[14px] leading-6 text-ops-ink/90" />
      </div>
      {examples.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-1.5 text-[12px] font-semibold text-ops-sub">
            이 FAQ로 AI가 답한 최근 고객 질문
          </h3>
          <ul className="flex flex-col gap-1">
            {examples.map((e) => (
              <li key={e.key} className="flex items-baseline gap-3 text-[13px]">
                <span className="shrink-0 whitespace-nowrap text-ops-faint tabular-nums">
                  {e.at}
                </span>
                {e.call ? (
                  <Link
                    to={`/calls/${e.call}`}
                    state={{ at: e.iso }} // 통화 상세가 이 질문을 한 말로 바로 스크롤
                    className="min-w-0 hover:text-ops-route hover:underline"
                  >
                    “{e.text}”
                  </Link>
                ) : (
                  <span className="min-w-0">“{e.text}”</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4 flex items-center gap-2">
        <Btn kind="edit" onClick={onEdit}>
          수정
        </Btn>
        <Btn kind="danger" onClick={del.ask}>
          삭제
        </Btn>
        <span className="ml-auto text-[12px] text-ops-faint tabular-nums">
          마지막 수정일 : {ymd(f.updatedAt)}
        </span>
      </div>
      {del.confirming && (
        <Confirm
          title="FAQ를 삭제할까요?"
          ok="삭제"
          danger
          busy={del.pending}
          error={del.error}
          onOk={del.confirm}
          onClose={del.cancel}
        >
          “{f.question}” 질문을 삭제합니다. AI가 더는 이 답을 쓰지 않습니다.
        </Confirm>
      )}
    </div>
  )
}

/** 추가 · 수정 칸 (분류 · 질문 · 답변). 분류 처음 값은 추가 = 왼쪽에서 고른 분류(전체 · 미답변이면 없음), 수정 = 그 FAQ 분류 */
function FaqForm({
  faq,
  from,
  category,
  onDone,
  title,
}: {
  faq?: Faq
  from?: UnansweredQuestion
  category: FaqCategory | null
  onDone: () => void
  title: string
}) {
  const f = useFaqForm({ faq, from, category, onSaved: onDone })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (f.canSubmit) f.submit()
      }}
      className="flex flex-col gap-3 rounded-lg border border-ops-route bg-white p-4"
    >
      <p className="text-[12px] font-semibold text-ops-route">{title}</p>
      <Choice label="분류" value={f.category} onChange={f.setCategory} options={f.categories} />
      <Field label="질문">
        <input
          value={f.question}
          onChange={(e) => f.setQuestion(e.target.value)}
          autoFocus
          className="h-10 w-full rounded-md px-3 text-[15px] font-semibold ring-1 ring-ops-line outline-none ring-inset focus:ring-ops-route"
        />
      </Field>
      <Field label="답변">
        <textarea
          value={f.answer}
          onChange={(e) => f.setAnswer(e.target.value)}
          rows={5}
          className="w-full resize-y rounded-md px-3 py-2 text-[14px] leading-6 ring-1 ring-ops-line outline-none ring-inset focus:ring-ops-route"
        />
      </Field>
      <div className="flex items-center justify-end gap-2">
        {f.error && <span className="mr-auto text-[12px] text-ops-stop">{f.error}</span>}
        <Btn onClick={onDone}>취소</Btn>
        <Btn kind="primary" type="submit" disabled={!f.canSubmit}>
          저장
        </Btn>
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-ops-sub">{label}</span>
      {children}
    </label>
  )
}
