// 미답변 문의 (11/06) — AI가 답하지 못한 질문 처리 대기열. 오래된 것부터(먼저 쌓인 것부터 처리)
// 줄: 질문 | 사유 | 고객 · 전화 | 통화 시각 | [FAQ로 만들기] [삭제]. 질문을 누르면 그 통화 상세
// 데이터 · 검색 · 삭제는 기존 useUnansweredList 그대로. [FAQ로 만들기] = FAQ의 추가 칸에 고객 말을 채워 감 (저장하면 처리됨)
import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { reasonTag } from '@/shared/lib/unansweredReason'
import { useUnansweredList, type UnansweredRow } from '@/features/faq/hooks/useUnansweredList'
import { PageHead } from '@/shared/ui'
import { Badge, Btn, Icon, SortTh } from '@/shared/ui'
import { SearchBox } from '@/shared/ui/ListFrame'
import { useScrollable } from '@/shared/lib/useScrollable'
import { useKeepScroll } from '@/shared/lib/keepScroll'
import { Confirm } from '@/shared/ui/Modal'
import { UnansweredCall } from './UnansweredCall'
import { dateTime } from '@/shared/lib/when'
import { useListParams } from '@/shared/lib/useListParams'
import { usePageSize } from '@/shared/lib/paging'
import { Pagination } from '@/shared/ui/Pagination'

// d = 통화 시각 정렬 — 처리 대기열이라 기본은 오래된 순, 'desc'면 최신순
const PARAMS = { d: 'asc' }

export function UnansweredPage() {
  const vm = useUnansweredList()
  const navigate = useNavigate()
  const { pathname, search } = useLocation()
  // 목록은 한 번에 받아 두고 화면에서 쪽을 나눔 (검색을 바꾸면 기존 훅이 쪽을 1로)
  const { params, page: rawPage, set } = useListParams(PARAMS)
  const asc = params.d !== 'desc'
  const all = vm.groups.flatMap((g) => g.rows.map((r) => ({ ...r, day: g.label })))
  if (!asc) all.reverse()
  const [size, setSize] = usePageSize()
  const page = Math.min(rawPage, Math.max(1, Math.ceil(all.length / size)))
  const rows = all.slice((page - 1) * size, page * size)
  const box = useRef<HTMLDivElement>(null)
  const scrollable = useScrollable(box, [rows])
  useKeepScroll(box, 'list')
  const [open, setOpen] = useState<(UnansweredRow & { day: string }) | null>(null)
  const toFaq = (r: UnansweredRow) =>
    navigate('/faqs', { state: { from: r, back: pathname + search } })

  return (
    <>
      <PageHead title="미답변 문의">
        <SearchBox
          value={vm.q}
          onChange={vm.setQ}
          placeholder="질문, 이름, 전화번호로 검색"
          label="미답변 검색"
        />
        {vm.callChip && (
          <span className="inline-flex h-8 items-center gap-1 rounded-full bg-ops-route-soft pr-1.5 pl-3 text-[13px] font-medium text-ops-route">
            {vm.callChip}
            <button
              type="button"
              aria-label="필터 지우기"
              onClick={vm.clearCall}
              className="grid size-6 place-items-center rounded-full hover:bg-white"
            >
              <Icon name="x" className="size-3.5" />
            </button>
          </span>
        )}
      </PageHead>
      <section
        aria-label="미답변 문의 목록"
        className="flex min-h-0 flex-1 flex-col gap-3 px-6 pt-4 pb-4"
      >
        <p className="text-[13px] text-ops-sub">
          질문{' '}
          <b className="font-semibold text-ops-ink tabular-nums">
            {vm.count.toLocaleString('ko-KR')}
          </b>
          건
        </p>
        <div
          ref={box}
          data-scrollable={scrollable || undefined}
          className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto rounded-lg border border-ops-line bg-white"
        >
          <table className="ops-table min-w-[1160px]">
            <thead>
              <tr>
                <th scope="col">고객이 한 질문</th>
                <th scope="col" className="w-[120px]">
                  사유
                </th>
                <th scope="col" className="w-[230px]">
                  고객
                </th>
                <SortTh
                  label="통화"
                  asc={asc}
                  onToggle={() => set({ d: asc ? 'desc' : 'asc' })}
                  className="w-[150px]"
                />
                <th scope="col" className="w-[150px] text-right">
                  처리
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row
                  key={r.unansweredQuestionSeq}
                  r={r}
                  vm={vm}
                  onFaq={() => toFaq(r)}
                  onOpen={() => setOpen(r)}
                />
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
              {vm.isLoading
                ? '불러오는 중…'
                : (vm.listError ??
                  (vm.q ? '검색어에 맞는 질문이 없습니다.' : 'AI가 답하지 못한 질문이 없습니다.'))}
            </p>
          )}
          {vm.listNote && <p className="px-4 py-3 text-[12px] text-ops-faint">{vm.listNote}</p>}
        </div>
        <Pagination
          page={page}
          size={size}
          total={all.length}
          onPage={(p) => set({ page: p })}
          onSize={setSize}
        />
      </section>
      {open && (
        <UnansweredCall
          callSeq={open.callSessionSeq}
          unansweredSeq={open.unansweredQuestionSeq}
          question={open.question}
          who={`${open.customerName} ${open.phone}`}
          onClose={() => setOpen(null)}
        />
      )}
      {vm.modal?.kind === 'delete' && (
        <Confirm
          title="질문을 삭제할까요?"
          ok="삭제"
          danger
          busy={vm.isDeleting}
          error={vm.deleteError}
          onOk={vm.confirmDelete}
          onClose={vm.closeModal}
        >
          “{vm.modal.item.question}” 질문을 미답변 목록에서 삭제합니다.
        </Confirm>
      )}
    </>
  )
}

function Row({
  r,
  vm,
  onFaq,
  onOpen,
}: {
  r: UnansweredRow & { day: string }
  vm: ReturnType<typeof useUnansweredList>
  onFaq: () => void
  onOpen: () => void
}) {
  const reason = reasonTag(r.reason)
  const asking = vm.modal?.item.unansweredQuestionSeq === r.unansweredQuestionSeq
  return (
    <tr className={`${asking ? 'bg-ops-stop-soft/50' : ''}`}>
      {/* 칸 어디를 눌러도 화면을 옮기지 않고 그 통화 창 (질문한 말로 바로 스크롤, 11/09 사용자).
          버튼은 onClick 없이 남김 — 마우스 · Enter 클릭이 칸으로 올라와 한 번만 열리고, 키보드로도 열림 */}
      <td
        onClick={onOpen}
        title="이 질문이 나온 통화 보기"
        className="group cursor-pointer text-left"
      >
        <button
          type="button"
          className="line-clamp-2 text-left font-medium group-hover:text-ops-route"
        >
          “{r.question}”
        </button>
      </td>
      <td>
        <Badge tone={r.reason === 'KB_NO_ANSWER' ? 'wait' : 'stop'}>{reason.label}</Badge>
      </td>
      <td>
        <span className="flex min-w-0 items-baseline justify-center gap-2">
          <span className="max-w-[5.5em] shrink-0 truncate font-medium">{r.customerName}</span>
          <span className="truncate text-[13px] whitespace-nowrap text-ops-sub tabular-nums">
            {r.phone}
          </span>
        </span>
      </td>
      <td className="text-[13px] whitespace-nowrap text-ops-sub tabular-nums">
        {dateTime(r.startedAt) || '—'}
      </td>
      <td>
        {
          <span className="flex items-center justify-center gap-1.5">
            <Btn kind="primaryBadge" onClick={onFaq}>
              FAQ 등록
            </Btn>
            <Btn kind="dangerBadge" onClick={() => vm.openDelete(r)} aria-label="이 질문 삭제">
              삭제
            </Btn>
          </span>
        }
      </td>
    </tr>
  )
}
