import { useState, type KeyboardEvent, type UIEvent } from 'react'
import { Button, ConfirmDialog, Highlight, TopBar } from '@/shared/ui'
import { useUnansweredList, type UnansweredRow } from '@/features/faq/hooks/useUnansweredList'
import { Icon } from './icons'

// 09 AI 미답변 문의 (Figma 'FAQ 미답변' 11/06) — 상단바: 왼쪽 경로 '[이동 전 화면] > AI 미답변 문의' · 가운데 이 목록 검색칸 · 오른쪽 상태
// 본문(카드 양끝 100 안쪽): 머리줄 '📅 11월 4일'(16/600, 맨 위 줄의 날) + 진한 선 — 03 · 04와 같은 틀. 날이 바뀌는 첫 줄은 표 왼쪽 바깥에 '11월 3일'
// 줄 72 = 시각(오후 3:02, 12) | “질문”(20/500) | 이름 | 전화번호 | [+] [휴지통]
// [+] = FAQ 화면 맨 위 추가 칸에 이 질문을 채워 감 (저장하면 처리됨) · [휴지통] = 확인 창. 줄을 누르면 그 통화의 06
// 쪽 번호 없이 본문만 스크롤 (스크롤 막대는 카드 오른쪽 끝). 오래된 질문부터 (먼저 쌓인 것부터 처리)
// 사유 칩 · 'AI 미답변 질문 n개' 줄은 새 디자인에 없어 뺌 (사유는 06 처리 내용에 그대로)
export function UnansweredPage() {
  const vm = useUnansweredList()
  const [top, setTop] = useState<string | null>(null) // 맨 위에 보이는 줄의 날
  const head = vm.groups.find((g) => g.day === top) ?? vm.groups[0]
  // ponytail: 스크롤마다 줄을 앞에서부터 훑음 (최대 2,000줄). 느려지면 이분 탐색으로
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const y = e.currentTarget.getBoundingClientRect().top
    const rows = e.currentTarget.querySelectorAll<HTMLElement>('[data-day]')
    const row = [...rows].find((r) => r.getBoundingClientRect().bottom > y + 1)
    if (row) setTop(row.dataset.day ?? null)
  }

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar
        wide
        crumbs={[vm.origin, { label: 'AI 미답변 문의' }]}
        center={
          <label className="flex h-9 min-w-0 items-center gap-2 rounded-lg pr-2 pl-4 ring-1 ring-field ring-inset focus-within:ring-brand">
            <Icon name="search" className="size-4 text-field" />
            <input
              value={vm.q}
              onChange={(e) => vm.setQ(e.target.value)}
              placeholder="AI가 답하지 못한 질문을 찾아보세요"
              aria-label="질문 · 이름 · 전화번호 검색"
              className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-field"
            />
            {vm.q && (
              <button
                type="button"
                aria-label="검색 지우기"
                onClick={() => vm.setQ('')}
                className="grid size-6 place-items-center rounded text-sub hover:bg-bg hover:text-ink"
              >
                <Icon name="x" className="size-4" />
              </button>
            )}
          </label>
        }
      />
      {vm.callChip && (
        // 06 '처리 내용 › AI 미답변 보기'로 왔을 때 — ✕ = 전체 미답변으로
        <div className="mt-2 shrink-0 px-[68px]">
          <span className="inline-flex h-8 items-center gap-1 rounded-full bg-brand/10 pr-1.5 pl-4 text-body font-medium text-brand">
            {vm.callChip}
            <button
              type="button"
              aria-label="필터 지우기 — 전체 미답변 보기"
              onClick={vm.clearCall}
              className="grid size-6 place-items-center rounded-full hover:bg-brand/15"
            >
              <Icon name="x" className="size-3.5" />
            </button>
          </span>
        </div>
      )}

      {head && (
        <div className="-mx-content shrink-0 px-[100px] pt-v28">
          <h2 className="flex h-[19px] items-center gap-2 text-body font-semibold">
            <Icon name="calendar" className="size-4" />
            {head.label}
          </h2>
          <div className="mt-3 border-t border-sub" />
        </div>
      )}
      <div
        onScroll={onScroll}
        className={`-mx-content min-h-0 flex-[1_1_0px] [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] overflow-y-auto pr-[90px] pb-4 pl-[100px] ${head ? '' : 'pt-v28'}`}
      >
        {vm.groups.length === 0 && (
          <p className="py-10 text-center text-body text-muted">
            {vm.isLoading
              ? '불러오는 중…'
              : (vm.listError ??
                (vm.q
                  ? '해당하는 질문이 없습니다.'
                  : vm.callChip
                    ? '이 통화의 질문은 모두 처리됐습니다.'
                    : 'AI가 답하지 못한 질문이 없습니다.'))}
          </p>
        )}
        <ul>
          {vm.groups.flatMap((g) =>
            g.rows.map((r, i) => (
              <Row
                key={r.unansweredQuestionSeq}
                r={r}
                vm={vm}
                day={g.day}
                dayLabel={i === 0 && g !== head ? g.label : null}
              />
            )),
          )}
        </ul>
        {vm.listNote && <p className="text-caption text-muted">{vm.listNote}</p>}
      </div>

      {vm.modal && (
        <ConfirmDialog
          big
          title="정말로 삭제하시겠습니까?"
          target={`“${vm.modal.item.question}”`}
          warn={vm.deleteError ?? undefined}
          okLabel="삭제"
          pending={vm.isDeleting}
          onOk={vm.confirmDelete}
          onClose={vm.closeModal}
        />
      )}
    </div>
  )
}

const ICON_BTN = 'grid size-8 place-items-center rounded text-ink hover:bg-surface hover:text-brand'

/** 한 줄 — 누르면(Enter · Space도) 그 통화의 06. 버튼 누름은 줄로 안 번짐. dayLabel = 날이 바뀌는 첫 줄이면 표 왼쪽 바깥에 '11월 3일' */
function Row({
  r,
  vm,
  day,
  dayLabel,
}: {
  r: UnansweredRow
  vm: ReturnType<typeof useUnansweredList>
  day: string
  dayLabel: string | null
}) {
  const open = () => vm.openCall(r)
  const onKey = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault() // Space가 화면을 내리지 않게
    open()
  }
  return (
    <li
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={onKey}
      title="이 질문이 나온 통화 상세"
      data-day={day}
      className="relative flex h-[clamp(56px,8dvh,72px)] items-center border-b border-line pl-3 outline-none hover:bg-bg focus-visible:ring-[1.5px] focus-visible:ring-brand focus-visible:ring-inset"
    >
      {dayLabel && (
        <span className="absolute top-1/2 -left-15 w-[42px] -translate-y-1/2 text-center text-[12px] font-medium whitespace-nowrap">
          {dayLabel}
        </span>
      )}
      <span className="w-[109px] shrink-0 text-[12px] text-sub">{r.time}</span>
      <span className="min-w-0 flex-1 truncate pr-6 text-card font-medium" title={r.question}>
        “<Highlight text={r.question} q={vm.q} />”
      </span>
      <span className="w-[70px] shrink-0 truncate pr-2 text-body font-medium">
        <Highlight text={r.customerName} q={vm.q} />
      </span>
      <span className="w-[203px] shrink-0 text-body font-medium tabular-nums">
        <Highlight text={r.phone} q={vm.q} />
      </span>
      <span
        className="-mr-1 flex shrink-0 gap-3"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="FAQ로 추가"
          title="FAQ로 추가"
          onClick={() => vm.openAdd(r)}
          className={ICON_BTN}
        >
          <Icon name="plus" className="size-6" />
        </button>
        <Button kind="deleteBadge" onClick={() => vm.openDelete(r)}>
          삭제
        </Button>
      </span>
    </li>
  )
}
