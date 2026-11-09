// 주문 상세의 '이어진 통화'를 누르면 주문 목록 자리에 뜨는 통화 창 — 오른쪽 송장은 그대로 두고 대화를 나란히 봄
// 통화 상세와 같은 한 줄 기록 — 말 사이에 AI 동작을 그 시각 자리에. 녹취는 [통화 상세 열기]. Esc · ✕로 닫힘
import { useEffect } from 'react'
import { Link } from 'react-router'
import { AiToggle } from '@/shared/call/AiSteps'
import { CallLog } from '@/shared/call/CallLog'
import { useShowAi } from '@/shared/lib/useShowAi'
import { Badge, Icon, Kinds } from '@/shared/ui'
import type { Waybill } from '../hooks/useWaybill'

export type LinkedCall = NonNullable<Waybill['view']>['calls'][number]

export function CallOverlay({ call, onClose }: { call: LinkedCall; onClose: () => void }) {
  const [showAi, setShowAi] = useShowAi()
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])

  return (
    <section
      role="dialog" // 열려 있는 동안 주문 패널의 Esc(패널 닫기)는 쉼
      aria-label={`통화 #${call.seq}`}
      className="absolute inset-x-6 top-4 bottom-4 z-20 flex flex-col overflow-hidden rounded-lg border border-ops-line bg-white shadow-lg motion-safe:animate-pop-in"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ops-line px-5">
        <Icon name="phone" className="size-4 text-ops-sub" />
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold">
            #{call.seq} {call.what}
          </h2>
          <p className="text-[12px] text-ops-sub tabular-nums">{call.at}</p>
        </div>
        <span className="flex gap-1">
          {call.analyzed ? <Kinds kinds={call.kinds} /> : <Badge tone="idle">분석 중</Badge>}
        </span>
        <span className="ml-auto">
          <AiToggle on={showAi} onChange={setShowAi} />
        </span>
        <Link
          to={`/calls/${call.seq}`}
          className="inline-flex h-8 items-center rounded-md px-3 text-[13px] font-semibold ring-1 ring-ops-line ring-inset hover:bg-ops-paper"
        >
          통화 상세 열기
        </Link>
        <button
          type="button"
          onClick={onClose}
          aria-label="통화 닫기"
          className="grid size-8 place-items-center rounded-md text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
        >
          <Icon name="x" />
        </button>
      </header>
      <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-4 py-4">
        <CallLog seq={call.seq} showAi={showAi} />
      </div>
    </section>
  )
}
