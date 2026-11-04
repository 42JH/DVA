import { useCallback, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import type { Ymd } from '@/shared/lib/dateRange'
import { useDismiss } from '@/shared/lib/useDismiss'
import { DayPick, DayScroll, Highlight, TopBar, TopSearch } from '@/shared/ui'
import { useCallList, type CallListRow } from '@/features/call/hooks/useCallList'
import { CallFilter } from './CallFilter'
import { KindChips } from './KindChips'

// 04 통화 내역 (Figma 디자인/목업 '통화' 11/04) — 상단바(상태 · AI 미답변 알림) · 머리(📅 날짜 · 상담가 | 필터) · 줄 목록
// 머리의 날짜 · 상담가는 맨 위 줄을 따라 바뀜. 날짜를 고르면 그 날로, 상담가를 고르면 그 상담가가 받은 가장 최근 통화로 이동
// 검색은 상단바 → 창 (11/05 사용자: 모든 화면 상단바 검색. 예전엔 머리 오른쪽 칸에 치는 대로)
// 줄 = 시각 | 상담 유형 칩(접수 · 조회 · 취소 · FAQ, 두 번 이상이면 숫자) · 불만(빨간 알약, 올리면 근거) | 이름(신규면 new) | 전화번호 | 통화 시간
// 무한 스크롤 (11/04 사용자 · shared/ui/DayScroll): 고른 날짜(기본 오늘)부터 — 아래로 내리면 지난 날, 위로 올리면 다음 날을 이어 받고, 머리 날짜는 맨 위 줄의 날짜를 따라감
// 목록만 스크롤(머리는 고정) · 줄을 누르면 06. 06에서 돌아오면 보던 자리 그대로 (받아 둔 목록 + 스크롤 위치)

export function CallListPage() {
  const vm = useCallList()
  const key = useLocation().search // 조건이 바뀌면 머리를 고른 날짜로 (목록도 맨 위부터 새로)
  // 맨 위에 보이는 줄의 날짜 · 상담가 (11/04 사용자: 둘 다 스크롤 따라 바뀜) — 조건이 바뀌면(key) 고른 날짜로 돌아감
  const [seen, setSeen] = useState<{ key: string; day: Ymd; persona: string | null } | null>(null)
  const now = seen?.key === key ? seen : null
  const day = now?.day ?? vm.anchor
  const persona = now?.persona ?? vm.activePersona // 맨 위 통화의 상담가를 모르면(분석 전) 지금 상담가
  const onTop = useCallback(
    (row: HTMLElement) => {
      // 상담가: 맨 위 줄이 분석 전이면 그 아래 줄들 중 처음 아는 것
      let n: Element | null = row
      let p: string | null = null
      while (n && !p) {
        p = (n as HTMLElement).dataset.persona ?? null
        n = n.nextElementSibling
      }
      setSeen({ key, day: row.dataset.day!, persona: p })
    },
    [key],
  )

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar
        search={
          <TopSearch
            name="통화 검색"
            fields={[{ value: vm.q }]}
            hint="고객 이름이나 전화번호로 찾아요."
            onApply={([q]) => vm.setQ(q)}
          />
        }
      />
      <div className="mt-2 flex h-[37px] shrink-0 items-center pr-[50px] pl-[58px]">
        <DayPick day={day} onPick={vm.setDate} />
        <PersonaToggle
          label={persona}
          personas={vm.personas}
          onPick={vm.pickPersona}
          jumping={vm.jumping}
          note={vm.jumpNote}
          onOpen={vm.resetJump}
        />
        <div className="ml-auto flex items-center gap-6">
          <CallFilter value={vm.form} active={vm.isFiltered} onApply={vm.applyForm} />
        </div>
      </div>
      <div className="mt-5 mr-[50px] ml-[58px] shrink-0 border-t border-line" />
      {/* 오른쪽 72 = 줄 끝이 디자인 1354(크롬 얇은 막대 10 포함) */}
      <DayScroll
        feed={vm.feed}
        at={vm.at}
        onTop={onTop}
        row={(r) => <CallLine key={r.callSessionSeq} r={r} q={vm.q} from={`/calls${key}`} />}
        end={(hasRows) =>
          hasRows
            ? '이전 통화가 없습니다.'
            : vm.q || vm.isFiltered
              ? '맞는 통화가 없습니다.'
              : '통화가 없습니다.'
        }
        className="pt-1.5 pr-[72px] pl-[58px]"
      />
    </div>
  )
}

/** 한 줄 (Figma 행 높이 70 · 글자 20) — 줄 전체가 06 링크 */
function CallLine({ r, q, from }: { r: CallListRow; q: string; from: string }) {
  return (
    <Link
      to={`/calls/${r.callSessionSeq}`}
      state={{ from }} // 06 경로 '통화'가 이 목록(날짜 · 검색 · 필터)으로 돌아오게
      data-row={r.callSessionSeq}
      data-day={r.day}
      data-persona={r.persona ?? undefined}
      // 칸 = Figma 자리(행 1200 기준): 시각 170 · 칩(남는 폭) · 이름 113 · 번호 171 · 통화 시간 120(오른쪽 맞춤). 칸 폭이 고정이라 줄마다 자리가 같음
      className="grid h-[70px] grid-cols-[170px_minmax(0,1fr)_113px_171px_120px] items-center border-b border-bg pr-[15px] pl-2 text-card hover:bg-bg"
    >
      <span className="text-sub">{r.time}</span>
      <span className="flex min-w-0 items-center gap-2 pr-4">
        {r.counts ? (
          <KindChips kinds={r.kinds} />
        ) : (
          <span className="text-body text-muted">분석 전</span>
        )}
        {r.complaint && <Complaint c={r.complaint} />}
      </span>
      <span className="flex min-w-0 items-start font-medium" title={r.name}>
        <span className="truncate">
          <Highlight text={r.name} q={q} />
        </span>
        {r.isNew && <sup className="mt-1 ml-1 text-[12px] font-normal text-brand">new</sup>}
      </span>
      <span className="font-medium tabular-nums">
        <Highlight text={r.phone} q={q} />
      </span>
      <span className="text-right text-sub">{r.duration}</span>
    </Link>
  )
}

/** 불만 알약 — 마우스를 올리면 아래에 고객이 한 말(근거) */
function Complaint({ c }: { c: NonNullable<CallListRow['complaint']> }) {
  return (
    <span className="group/c relative ml-auto shrink-0">
      <span className="inline-flex h-7 items-center rounded-xl bg-danger px-3 text-body font-bold text-white">
        {c.label}
      </span>
      <span
        role="tooltip"
        className="invisible absolute top-full left-0 z-10 mt-2 flex flex-col gap-1 rounded-lg bg-surface py-1 pr-7 pl-3 text-body whitespace-nowrap text-sub shadow-[0_4px_10px_rgba(0,0,0,0.07)] group-hover/c:visible"
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

/** 날짜 옆 상담가 이름 — 맨 위 통화를 받은 상담가(스크롤 따라 바뀜). 누르고 고르면 그 상담가가 받은 가장 최근 통화로 (11/04 사용자) */
function PersonaToggle({
  label,
  personas,
  onPick,
  jumping,
  note,
  onOpen,
}: {
  label: string | null
  personas: { personaSeq: number; name: string; inUse: boolean }[]
  onPick: (personaSeq: number) => void
  jumping: boolean
  note: string | null // 찾지 못함 · 받은 통화 없음
  onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(open, root, close)
  return (
    // 날짜 글자와 같은 가운데 줄 (11/05 사용자 — 예전엔 위 10 띄워 날짜보다 아래에 있었음)
    <div ref={root} className="relative ml-6 flex items-baseline gap-3">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen()
          setOpen((o) => !o)
        }}
        className="text-body font-semibold hover:text-brand"
      >
        {label ?? '상담가'}
      </button>
      {(jumping || note) && (
        <span className="text-caption text-muted">{jumping ? '찾는 중…' : note}</span>
      )}
      {open && (
        <div
          role="menu"
          aria-label="상담가 — 고르면 그 상담가가 받은 가장 최근 통화로"
          className="absolute top-full left-0 z-20 mt-2 w-max min-w-44 origin-top-left overflow-hidden rounded-xl bg-surface py-1 shadow-[0_12px_12px_rgba(0,0,0,0.08),0_2px_4px_rgba(0,0,0,0.04)] ring-1 ring-line motion-safe:animate-pop-in"
        >
          {personas.map((p) => (
            <button
              key={p.personaSeq}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(p.personaSeq)
                close()
              }}
              className={`flex h-11 w-full items-center gap-2 px-4 text-left text-body ${p.name === label ? 'font-semibold text-brand' : 'text-ink hover:bg-bg'}`}
            >
              {p.name}
              {p.inUse && <span className="text-caption font-normal text-muted">사용 중</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
