import type { KeyboardEvent } from 'react'
import { useLiveSearch } from '@/shared/lib/useLiveSearch'
import { Button, ConfirmDialog, Highlight, Pagination, TopBar } from '@/shared/ui'
import { useUnansweredList, type UnansweredRow } from '@/features/faq/hooks/useUnansweredList'

// 09 AI 미답변 — 옛 구성 그대로(검색칸 · 적용된 필터 · 'AI 미답변 질문 n개' · 표 · 쪽 번호)에 새 디자인만 입힘 (11/05 사용자: 구성은 두고 디자인만)
// 상단바: 경로 '[이동 전 화면] > AI 미답변' · 알림. 표는 03 주문 · 04 통화 목록 말투 — 열 머리 20/600 · 아래 구분선 · 줄 글자 20 · 칩 · 새 버튼
// 줄 = 통화 시작 시각 | 고객 · 발신번호 | 사유 칩 | “질문” | [FAQ 추가](파랑 선 → FAQ 작성 화면) [삭제](빨강 선 → 확인 창). 줄을 누르면 그 통화의 06
// 한 화면에: 표 줄만 스크롤 (머리 · 쪽 번호는 고정). 오래된 질문부터 (먼저 쌓인 것부터 처리)
const COLS = 'grid grid-cols-[170px_200px_170px_minmax(0,1fr)_196px]'
const PAD = 'px-[54px]' // 03 주문 목록과 같은 좌우 자리
// 사유 칩 바탕 — 04 상담 유형 칩 색 집합에서: 근거 부족(FAQ로 채울 것) = FAQ 남보라 · 검색 장애 = 분홍 · 미분류 = 회색
const REASON_BG = { KB_NO_ANSWER: 'bg-kind-faq', KB_UNAVAILABLE: 'bg-kind-cancel', none: 'bg-bg' }

export function UnansweredPage() {
  const vm = useUnansweredList()

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar crumbs={[vm.origin, { label: 'AI 미답변' }]} />

      <div className={`mt-2 shrink-0 ${PAD}`}>
        <UnansweredSearch q={vm.q} onSearch={vm.setQ} />
      </div>
      {vm.callChip && (
        // 06 '처리 내용 › AI 미답변 보기'로 왔을 때 — ✕ = 전체 미답변으로
        <div className={`mt-3 shrink-0 ${PAD}`}>
          <span className="inline-flex h-8 items-center gap-1 rounded-full bg-brand/10 pr-1.5 pl-4 text-body font-medium text-brand">
            {vm.callChip}
            <button
              type="button"
              aria-label="필터 지우기 — 전체 미답변 보기"
              onClick={vm.clearCall}
              className="grid size-6 place-items-center rounded-full hover:bg-brand/15"
            >
              <svg
                viewBox="0 0 20 20"
                className="size-3.5 stroke-current"
                strokeWidth={2}
                aria-hidden
              >
                <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
              </svg>
            </button>
          </span>
        </div>
      )}

      <h2 className={`mt-v32 flex shrink-0 items-baseline gap-3 text-title font-semibold ${PAD}`}>
        AI 미답변 질문
        <span className="text-body font-normal text-sub">{vm.count}개</span>
        {vm.listNote && <span className="text-caption font-normal text-muted">{vm.listNote}</span>}
      </h2>
      <div className={`${COLS} mt-5 shrink-0 items-center text-card font-semibold ${PAD}`}>
        <span>통화 시작 시각</span>
        <span>고객 · 발신번호</span>
        <span>사유</span>
        <span>질문</span>
        <span />
      </div>
      <div className="mx-[54px] mt-4 shrink-0 border-t border-line" />
      {/* 줄 상자: 스크롤 막대는 카드 오른쪽 끝 — 03 주문 목록과 같은 자리 (오른쪽 76 = 막대 10 포함) */}
      <ul className="-mr-8 min-h-0 flex-[1_1_0px] [scrollbar-width:thin] [scrollbar-color:var(--color-line)_transparent] [scrollbar-gutter:stable] overflow-y-auto pr-[76px] pl-[54px]">
        {vm.rows.length === 0 && (
          <li className="py-10 text-center text-body text-muted">
            {vm.isLoading
              ? '불러오는 중…'
              : (vm.listError ??
                (vm.q
                  ? '해당하는 질문이 없습니다.'
                  : vm.callChip
                    ? '이 통화의 질문은 모두 처리됐습니다.'
                    : 'AI가 답하지 못한 질문이 없습니다.'))}
          </li>
        )}
        {vm.rows.map((r) => (
          <Row key={r.unansweredQuestionSeq} r={r} vm={vm} />
        ))}
      </ul>

      <div className="shrink-0 pt-4">
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

/** 표 한 줄 — 누르면(Enter · Space도) 그 통화의 06. 버튼 누름은 줄로 안 번짐 */
function Row({ r, vm }: { r: UnansweredRow; vm: ReturnType<typeof useUnansweredList> }) {
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
      className={`${COLS} min-h-[84px] items-center border-b border-bg py-3 text-card outline-none hover:bg-bg focus-visible:ring-[1.5px] focus-visible:ring-brand focus-visible:ring-inset`}
    >
      <span className="text-sub">
        {r.time.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </span>
      <span className="flex min-w-0 flex-col pr-4">
        <span className="truncate font-medium">
          <Highlight text={r.customerName} q={vm.q} />
        </span>
        <span className="text-body text-sub tabular-nums">
          <Highlight text={r.phone} q={vm.q} />
        </span>
      </span>
      <span>
        <span
          className={`inline-grid h-7 place-items-center px-3 text-body ${REASON_BG[r.reason ?? 'none']}`}
        >
          {r.reasonTag.label}
        </span>
      </span>
      <span className="truncate pr-4" title={r.question}>
        “<Highlight text={r.question} q={vm.q} />”
      </span>
      <span
        className="flex justify-end gap-2"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Button big kind="brandLine" onClick={() => vm.openAdd(r)}>
          FAQ 추가
        </Button>
        <Button big kind="dangerLine" onClick={() => vm.openDelete(r)}>
          삭제
        </Button>
      </span>
    </li>
  )
}

/** 검색칸 (03 주문 검색칸과 같은 모양 — 높이 36 · 선 1 · 모서리 8) — 창 없이 치는 대로 표가 바뀜 */
function UnansweredSearch({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const { text, setText, clear, onKeyDown } = useLiveSearch(q, onSearch)
  return (
    <label className="flex h-9 w-[480px] max-w-full items-center gap-4 rounded-lg border border-field bg-surface pr-2 pl-5 focus-within:border-brand">
      <svg
        viewBox="-0.58 -0.58 16 16"
        className="size-4 shrink-0 text-field"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        aria-hidden
      >
        <circle cx="6.08" cy="6.08" r="5.33" />
        <path d="M10.08 10.08l4 4" />
      </svg>
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="질문 · 이름 · 전화번호"
        aria-label="AI 미답변 검색 (질문 · 이름 · 전화번호)"
        className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
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
