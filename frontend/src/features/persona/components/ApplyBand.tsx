import type { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { Badge, Btn, Segments } from '@/shared/ui'

type Vm = ReturnType<typeof usePersonaPage>
type Band = NonNullable<Vm['band']>

// 띠 (11/13 새 안 1번) — 반영 전(피그마 2368:2847) · 시험 중(3212) · 반영 중(3388) — 저장했지만 아직 통화에 안 쓰이는 버전이 있을 때
// [반영 전] 고친 내용 · 저장 시각 · 수정한 사람 | [통화에 반영]  /  아래 줄 토글: 고친 내용 ↔ 통화에 쓰는 내용
// busy: 프롬프트를 고치는 중 — 저장 안 한 글은 반영되지 않으니 [통화에 반영]을 끔
export function ApplyBand({
  band,
  showCall,
  setShowCall,
  onApply,
  onProgress,
  busy,
}: {
  band: Band
  showCall: boolean
  setShowCall: (v: boolean) => void
  onApply: () => void
  onProgress?: () => void // [진행 보기] — 시나리오 시험 화면
  busy: boolean
}) {
  // 시험 · 반영 중 — 버튼은 [진행 보기]만(시험 중), 토글 없음 (피그마 2368:3212 · 3388)
  if (band.step !== 'unapplied') {
    const p = band.progress
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-ops-wait/20 bg-ops-wait-soft px-7 py-3">
        <Badge tone="wait">{band.step === 'testing' ? '시험 중' : '반영 중'}</Badge>
        <span className="text-[15px] font-bold">
          {band.step === 'testing' ? '통화에 반영하기 전 시험' : '고친 내용'}
        </span>
        {p ? (
          <>
            <span className="text-[13px] text-ops-sub">
              시나리오 {p.ended} / {p.total}
            </span>
            <progress
              value={p.ended}
              max={p.total || 1}
              aria-label="시험 진행"
              className="h-1.5 w-40 appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-ops-wait [&::-webkit-progress-bar]:bg-ops-line [&::-webkit-progress-value]:bg-ops-wait"
            />
            <span className="text-[13px] text-ops-sub">통과 {p.pass}</span>
            {p.fail > 0 && <span className="text-[13px] text-ops-stop">실패 {p.fail}</span>}
          </>
        ) : (
          <span className="text-[13px] text-ops-sub">
            {band.time} 저장
            {band.applyError
              ? ' · AI 반영 오류가 있어 AI 확인을 다시 기다리는 중입니다'
              : ' · AI 확인이 끝나면 통화에 들어갑니다'}
          </span>
        )}
        {band.step === 'testing' && onProgress && (
          <Btn className="ml-auto" onClick={onProgress}>
            진행 보기
          </Btn>
        )}
      </div>
    )
  }
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-ops-wait/20 bg-ops-wait-soft px-7 py-3">
        <Badge tone="wait">반영 전</Badge>
        <span className="text-[15px] font-bold">고친 내용</span>
        <span className="text-[13px] text-ops-sub">
          {band.time} 저장{band.author && ` · ${band.author}`}
        </span>
        {band.error && (
          <span role="alert" className="ml-auto text-[12px] text-ops-stop">
            {band.error}
          </span>
        )}
        {band.canApply && (
          <Btn
            kind="line"
            className={band.error ? '' : 'ml-auto'}
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
