import type { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { Badge, Btn, Segments } from '@/shared/ui'

type Vm = ReturnType<typeof usePersonaPage>
type Band = NonNullable<Vm['band']>

// 반영 전 띠 (11/13 새 안 1번, 피그마 2368:2847) — 저장했지만 아직 통화에 안 쓰이는 버전이 있을 때
// [반영 전] 고친 내용 · 저장 시각 · 수정한 사람 | [통화에 반영]  /  아래 줄 토글: 고친 내용 ↔ 통화에 쓰는 내용
// busy: 프롬프트를 고치는 중 — 저장 안 한 글은 반영되지 않으니 [통화에 반영]을 끔
export function ApplyBand({
  band,
  showCall,
  setShowCall,
  onApply,
  busy,
}: {
  band: Band
  showCall: boolean
  setShowCall: (v: boolean) => void
  onApply: () => void
  busy: boolean
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-ops-wait/20 bg-ops-wait-soft px-7 py-3">
        <Badge tone="wait">반영 전</Badge>
        <span className="text-[15px] font-bold">고친 내용</span>
        <span className="text-[13px] text-ops-sub">
          {band.time} 저장{band.author && ` · ${band.author}`}
        </span>
        {band.canApply && (
          <Btn
            kind="line"
            className="ml-auto"
            disabled={busy}
            title={busy ? '고친 내용을 먼저 저장해 주세요' : undefined}
            onClick={onApply}
          >
            통화에 반영
          </Btn>
        )}
      </div>
      {band.canCompare && (
        <div className="border-b border-ops-line px-7 py-3">
          <Segments
            label="보는 내용"
            value={showCall ? 'call' : 'edit'}
            items={[
              { value: 'edit', label: '고친 내용' },
              { value: 'call', label: '통화에 쓰는 내용' },
            ]}
            onPick={(v) => setShowCall(v === 'call')}
          />
        </div>
      )}
    </>
  )
}
