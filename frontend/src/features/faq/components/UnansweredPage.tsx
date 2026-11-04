import { useLiveSearch } from '@/shared/lib/useLiveSearch'
import { Button, ConfirmDialog, Highlight, Pagination, TopBar } from '@/shared/ui'
import {
  useUnansweredList,
  type ReasonKey,
  type UnansweredRow,
} from '@/features/faq/hooks/useUnansweredList'
import { FAQ_GRID } from './FaqCategories'

// 09 AI 미답변 — Figma에 없어 FAQ 목록(Figma 'FAQ' 11/04)과 같은 틀로 만든 모양 (11/05 사용자)
// 상단바: 경로 '[이동 전 화면] > AI 미답변'(11/05 사용자 — 예: '통화 > AI 미답변', 06에서 왔으면 '통화 상세 > AI 미답변 > 강도윤 통화', 모르면 'FAQ')
//   · 가운데 검색칸(질문 · 이름 · 전화번호, 치는 대로) · 알림
// 왼쪽: 분류 자리에 사유 — 전체 · 답변 근거 부족 · 지식 검색 장애 · 미분류 (고른 것 파랑, 옆에 개수)
// 오른쪽: 'Q “고객이 한 말”'(FAQ 줄과 같은 글자) / 아래 사유 칩 · 고객 · 번호 · '통화 시각 ›'(06) | [FAQ 추가](파랑 선 → FAQ 작성 화면) · 🗑(삭제 확인)
// 맨 아래 가운데 쪽 번호 (FAQ와 같음) · 오래된 질문부터 (먼저 쌓인 것부터 처리)
// 한 화면에: 한 쪽 5줄 = 1440 노트북(화면 높이 ~780)에서 쪽 번호까지 다 보임. 더 낮은 화면에선 목록 상자만 스크롤 (페이지는 안 밀림)
const PAGE_SIZE = 5

// 사유 칩 바탕 — 04 상담 유형 칩 색 집합에서: 근거 부족(FAQ로 채울 것) = FAQ 남보라 · 검색 장애 = 분홍 · 미분류 = 회색
const REASON_BG: Record<Exclude<ReasonKey, ''>, string> = {
  KB_NO_ANSWER: 'bg-kind-faq',
  KB_UNAVAILABLE: 'bg-kind-cancel',
  none: 'bg-bg',
}

export function UnansweredPage() {
  const vm = useUnansweredList({ pageSize: PAGE_SIZE })

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar
        crumbs={[
          vm.origin,
          vm.callLabel ? { label: 'AI 미답변', to: vm.allTo } : { label: 'AI 미답변' },
          ...(vm.callLabel ? [{ label: vm.callLabel }] : []),
        ]}
        search={<UnansweredSearch q={vm.q} onSearch={vm.setQ} />}
      />

      <div className={`${FAQ_GRID} min-h-0 flex-1 grid-rows-[minmax(0,1fr)] pt-v76`}>
        <nav aria-label="사유" className="flex flex-col items-start gap-v24 pl-9">
          {vm.reasons.map((r) => (
            <button
              key={r.key}
              type="button"
              aria-current={vm.reason === r.key ? 'true' : undefined}
              onClick={() => vm.setReason(r.key)}
              className={`flex items-baseline gap-2 text-v24 font-semibold ${vm.reason === r.key ? 'text-brand' : 'text-sub hover:text-ink'}`}
            >
              {r.label}
              <span className="text-body font-normal">{r.count}</span>
            </button>
          ))}
        </nav>

        <div className="min-h-0 min-w-0 [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] overflow-y-auto pr-2 pl-5">
          {vm.listNote && <p className="mb-3 text-caption text-muted">{vm.listNote}</p>}
          {vm.rows.length ? (
            <ul className="flex flex-col gap-v24">
              {vm.rows.map((r) => (
                <Row key={r.unansweredQuestionSeq} r={r} vm={vm} />
              ))}
            </ul>
          ) : (
            <p className="text-body text-sub">
              {vm.isLoading
                ? '불러오는 중…'
                : (vm.listError ??
                  (vm.q || vm.reason
                    ? '맞는 질문이 없습니다.'
                    : vm.callLabel
                      ? '이 통화의 질문은 모두 처리됐습니다.'
                      : 'AI가 답하지 못한 질문이 없습니다.'))}
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 pt-6">
        <Pagination big page={vm.page} pages={vm.pages} onChange={vm.goPage} />
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

/** 질문 한 줄 — 'Q “말”'(24) / 사유 칩 · 고객 · 번호 · 통화 시각 › | [FAQ 추가] 🗑 */
function Row({ r, vm }: { r: UnansweredRow; vm: ReturnType<typeof useUnansweredList> }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-5 border-b border-bg pb-v24">
      <span aria-hidden className="text-v24 text-muted">
        Q
      </span>
      <div className="min-w-0">
        {/* 고객 말은 길 수 있어 두 줄까지 (전체는 올리면) — FAQ 줄처럼 줄 높이가 고르게 */}
        <p className="line-clamp-2 text-v24 break-words" title={r.question}>
          “<Highlight text={r.question} q={vm.q} />”
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-sub">
          <span
            className={`grid h-7 shrink-0 place-items-center px-3 text-ink ${REASON_BG[r.reason ?? 'none']}`}
          >
            {r.reasonTag.label}
          </span>
          <span>
            <Highlight text={r.customerName} q={vm.q} /> · <Highlight text={r.phone} q={vm.q} />
          </span>
          <button
            type="button"
            onClick={() => vm.openCall(r)}
            title="이 질문이 나온 통화 상세"
            className="font-semibold text-brand hover:underline"
          >
            {r.time.join(' ')} 통화 ›
          </button>
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button big kind="brandLine" onClick={() => vm.openAdd(r)}>
          FAQ 추가
        </Button>
        <button
          type="button"
          aria-label={`“${r.question}” 삭제`}
          title="삭제"
          onClick={() => vm.openDelete(r)}
          className="grid size-8 place-items-center rounded-lg text-sub hover:bg-danger-soft hover:text-danger"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-6"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M4 6.18h16M10 16.76v-6.35M14 16.76v-6.35M16 21H8c-1.1 0-2-.95-2-2.12V7.24c0-.59.45-1.06 1-1.06h10c.55 0 1 .47 1 1.06v11.64c0 1.17-.9 2.12-2 2.12Zm-6-14.82h4c.55 0 1-.47 1-1.06V4.06C15 3.47 14.55 3 14 3h-4c-.55 0-1 .47-1 1.06v1.06c0 .59.45 1.06 1 1.06Z" />
          </svg>
        </button>
      </div>
    </li>
  )
}

/** 상단바 가운데 검색칸 (FAQ 검색칸과 같은 모양 — 폭 317 · 높이 32) — 창 없이 치는 대로 목록이 바뀜 (04 · 03과 같음) */
function UnansweredSearch({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const { text, setText, clear, onKeyDown } = useLiveSearch(q, onSearch)
  return (
    <label className="flex h-8 w-full items-center gap-6 rounded-lg bg-surface pr-2 pl-5 text-body ring-1 ring-sub ring-inset focus-within:ring-brand">
      <svg
        viewBox="0 0 20 20"
        className="size-4 shrink-0 stroke-sub"
        fill="none"
        strokeWidth={1.6}
        strokeLinecap="round"
        aria-hidden
      >
        <circle cx="8.5" cy="8.5" r="6" />
        <path d="M13 13l4.5 4.5" />
      </svg>
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="질문 · 이름 · 전화번호"
        aria-label="AI 미답변 검색 (질문 · 이름 · 전화번호)"
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-sub [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          aria-label="검색 지우기"
          onClick={clear}
          className="grid size-6 shrink-0 place-items-center rounded text-sub hover:bg-bg hover:text-ink"
        >
          <svg viewBox="0 0 20 20" className="size-4 stroke-current" strokeWidth={1.8} aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </label>
  )
}
