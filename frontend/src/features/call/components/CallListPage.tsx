import { useCallback, useState } from 'react'
import { Link, useLocation } from 'react-router'
import type { Ymd } from '@/shared/lib/dateRange'
import { fmtMonthDay } from '@/shared/lib/format'
import { DayPick, DayScroll, HeadPick, Highlight, TopBar } from '@/shared/ui'
import { KindChips, PendingChip } from '@/shared/ui/KindChips'
import { useCallList, type CallListRow } from '@/features/call/hooks/useCallList'
import { CallFilter } from './CallFilter'

// 04 통화 내역 (Figma 디자인/목업 '통화' 1514:21223, 11/06 새 시안 — 03 주문과 같은 틀)
// 상단바: 필터 단추(검색칸 왼쪽) · 검색칸 '고객 정보를 입력해 주세요' · 상태(AppLayout)
// 표 머리줄(16/600): 📅 날짜 | 상담 유형 ⌄(하나 고르기) | 기업 | 이름 | 전화 번호 | (불만) | 통화 시간(오른쪽), 아래 1 회색 선
// 줄(높이 72): 시각 12 회색 | 상담 유형 알약(테두리 · 12) | 기업 · 이름 · 전화 번호(가운데 맞춤, 16/500) | 불만(빨간 알약, 올리면 근거) | 통화 시간 16 회색
// 표 왼쪽 바깥: 신규 고객이면 'new'(파랑) · 날이 바뀌는 첫 줄이면 '11월 3일' (머리줄 날짜 = 맨 위 줄의 날이라 같으면 안 붙음)
// 무한 스크롤 · 줄을 누르면 06 · 06에서 돌아오면 보던 자리 그대로 (shared/ui/DayScroll). 예전 날짜 옆 상담가 토글은 새 시안에 없어 뺌
// 칸 = 시안 자리(표 1172 기준): 시각 121(글자는 12 안쪽, 03 · 09와 같은 자리) · 상담 유형 252 · 기업 140 · 이름 100 · 전화 번호 120 · 불만(나머지) · 통화 시간 100
const COLS = 'grid grid-cols-[121px_minmax(0,252fr)_140px_100px_120px_minmax(0,339fr)_100px]'
// 표 좌우 자리: 카드에서 100 (본문 여백 32 빼고 68). 줄 상자는 막대 자리 때문에 오른쪽 90 (03 주문과 같음)
const PAD = 'pr-[68px] pl-[68px]'

export function CallListPage() {
  const vm = useCallList()
  const key = useLocation().search // 조건이 바뀌면 머리를 고른 날짜로 (목록도 맨 위부터 새로)
  const [seen, setSeen] = useState<{ key: string; day: Ymd } | null>(null) // 맨 위에 보이는 줄의 날
  const day = (seen?.key === key && seen.day) || vm.anchor
  const onTop = useCallback((row: HTMLElement) => setSeen({ key, day: row.dataset.day! }), [key])
  // 날마다 첫 줄 — 그 줄 왼쪽에 '11월 3일' (머리줄 날짜와 같은 날이면 안 붙임)
  const firstOfDay = new Set(vm.feed.days.map((d) => d.rows[0]?.callSessionSeq))

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar
        search={{ tab: 'call', q: vm.q, onApply: vm.setQ }}
        lead={<CallFilter value={vm.form} active={vm.isFiltered} onApply={vm.applyForm} />}
      />
      <div
        className={`${COLS} mt-v28 h-[19px] shrink-0 items-center ${PAD} text-body font-semibold`}
      >
        <DayPick small day={day} onPick={vm.setDate} />
        <HeadPick
          label="상담 유형"
          all="ALL"
          value={vm.kind}
          options={vm.kindOptions}
          onPick={vm.setKind}
        />
        <span className="text-center">기업</span>
        <span className="text-center">이름</span>
        <span className="text-center">전화 번호</span>
        <span />
        <span className="pr-3 text-right">통화 시간</span>
      </div>
      <div className="mt-3 mr-[68px] ml-[68px] shrink-0 border-t border-sub" />
      <DayScroll
        feed={vm.feed}
        at={vm.at}
        onTop={onTop}
        row={(r) => (
          <CallLine
            key={r.callSessionSeq}
            r={r}
            q={vm.q}
            from={`/calls${key}`}
            dayLabel={firstOfDay.has(r.callSessionSeq) && r.day !== day}
          />
        )}
        end={(hasRows) =>
          hasRows
            ? '이전 통화가 없습니다.'
            : vm.q || vm.isFiltered
              ? '맞는 통화가 없습니다.'
              : '통화가 없습니다.'
        }
        className="pr-[90px] pl-[68px]"
      />
    </div>
  )
}

/** 한 줄 (11/06 시안 높이 72) — 줄 전체가 06 링크. 표 왼쪽 바깥에 '11월 3일'(날이 바뀌는 첫 줄) · 'new'(신규 고객) */
function CallLine({
  r,
  q,
  from,
  dayLabel,
}: {
  r: CallListRow
  q: string
  from: string
  dayLabel: boolean
}) {
  return (
    <Link
      to={`/calls/${r.callSessionSeq}`}
      state={{ from }} // 06 경로 '통화'가 이 목록(날짜 · 검색 · 필터)으로 돌아오게
      data-row={r.callSessionSeq}
      data-day={r.day}
      className={`${COLS} relative h-[72px] items-center border-b border-line/70 text-body font-medium hover:bg-bg`}
    >
      {(dayLabel || r.isNew) && (
        <span className="absolute top-1/2 -left-15 flex w-[42px] -translate-y-1/2 flex-col items-center gap-0.5 text-[12px] leading-none whitespace-nowrap">
          {dayLabel && <span className="font-medium text-ink">{fmtMonthDay(r.day)}</span>}
          {r.isNew && <span className="font-normal text-brand">new</span>}
        </span>
      )}
      <span className="pl-3 text-[12px] font-normal text-sub">{r.time}</span>
      <span className="-ml-3 flex min-w-0 items-center gap-1 overflow-hidden">
        {r.counts ? <KindChips small kinds={r.kinds} /> : <PendingChip small />}
      </span>
      <span className="truncate text-center" title={r.company || undefined}>
        {r.company || <span className="text-muted">—</span>}
      </span>
      <span className="truncate text-center" title={r.name}>
        <Highlight text={r.name} q={q} />
      </span>
      <span className="text-center tabular-nums">
        <Highlight text={r.phone} q={q} />
      </span>
      <span className="flex min-w-0 pl-8">{r.complaint && <Complaint c={r.complaint} />}</span>
      <span className="pr-3 text-right font-normal text-sub">{r.duration}</span>
    </Link>
  )
}

/** 불만 알약 (11/06 시안: #fe4950 · 모서리 12 · 12/700 흰 글자) — 마우스를 올리면 아래에 고객이 한 말(근거) */
function Complaint({ c }: { c: NonNullable<CallListRow['complaint']> }) {
  return (
    <span className="group/c relative shrink-0">
      <span className="inline-flex h-6 items-center rounded-xl bg-[#fe4950] px-3 text-[12px] font-bold whitespace-nowrap text-white">
        {c.label}
      </span>
      <span
        role="tooltip"
        className="absolute top-full left-0 z-10 mt-2 hidden flex-col gap-1 rounded-lg bg-surface py-1 pr-7 pl-3 text-body font-normal whitespace-nowrap text-sub shadow-[0_4px_10px_rgba(0,0,0,0.07)] group-hover/c:flex"
      >
        {c.reasons.map((t, i) => (
          <span key={i} className="flex h-6 items-center gap-2">
            <svg
              viewBox="0 0 24 24"
              className="size-6 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 10.5V7M12 14h.01M7 18v2.34c0 .53 0 .8.11.94a.5.5 0 0 0 .39.19c.18 0 .38-.17.8-.5l2.39-1.91c.49-.39.73-.58 1-.72.24-.12.5-.21.76-.27.3-.06.61-.06 1.23-.06h2.52c1.68 0 2.52 0 3.16-.33a3 3 0 0 0 1.31-1.31c.33-.64.33-1.48.33-3.16V7.8c0-1.68 0-2.52-.33-3.16a3 3 0 0 0-1.31-1.31C18.72 3 17.88 3 16.2 3H7.8c-1.68 0-2.52 0-3.16.33a3 3 0 0 0-1.31 1.31C3 5.28 3 6.12 3 7.8V14c0 .93 0 1.4.1 1.78a3 3 0 0 0 2.12 2.12c.39.1.85.1 1.78.1Z" />
            </svg>
            {t}
          </span>
        ))}
      </span>
    </span>
  )
}
