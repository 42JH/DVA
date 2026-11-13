import type { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { Badge, Btn, Segments } from '@/shared/ui'

type Vm = ReturnType<typeof usePersonaPage>
type Band = NonNullable<Vm['band']>

// 띠 (11/13 새 안 1번) — 반영 전(피그마 2368:2847) · 시험 중(3212) · 반영 중(3388) — 저장했지만 아직 통화에 안 쓰이는 버전이 있을 때
// 6번 — 다른 상담가로 바꾸기(switchNote): 시험 중 '통화에 쓰기 전 시험' · 반영 중 '통화에 들어가는 중'. 시험 통과 띠는 PassBand
// 2번 — 시험 중 [시험 중단](2368:3753) → 시험 중단(4355): [지금까지 결과 보기] [다시 시험하고 반영]
// [반영 전] 고친 내용 · 저장 시각 · 수정한 사람 | [통화에 반영]  /  아래 줄 토글: 고친 내용 ↔ 통화에 쓰는 내용
// busy: 프롬프트를 고치는 중 — 저장 안 한 글은 반영되지 않으니 [통화에 반영]을 끔
export function ApplyBand({
  band,
  showCall,
  setShowCall,
  onApply,
  onProgress,
  onStop,
  onReview,
  busy,
}: {
  band: Band
  showCall: boolean
  setShowCall: (v: boolean) => void
  onApply: () => void
  onProgress?: () => void // [진행 보기] · [지금까지 결과 보기] — 시나리오 시험 화면
  onStop: () => void // [시험 중단] — 확인 창
  onReview: () => void // [확인하고 반영] — 실패한 시나리오 이름을 보여 주는 확인 창 (4번)
  busy: boolean
}) {
  // 시험 · 반영 중 — 버튼은 [진행 보기]만(시험 중), 토글 없음 (피그마 2368:3212 · 3388)
  if (band.step === 'testing' || band.step === 'applying') {
    const p = band.progress
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-ops-wait/20 bg-ops-wait-soft px-7 py-3">
        <Badge tone="wait">{band.step === 'testing' ? '시험 중' : '반영 중'}</Badge>
        <span className="text-[15px] font-bold">
          {band.step === 'testing'
            ? band.switchNote
              ? '통화에 쓰기 전 시험'
              : '통화에 반영하기 전 시험'
            : band.switchNote
              ? '통화에 들어가는 중'
              : '고친 내용'}
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
            {/* 0개도 보임 (시안) — 0이면 회색 */}
            <span className={`text-[13px] ${p.fail ? 'text-ops-stop' : 'text-ops-sub'}`}>
              실패 {p.fail}
            </span>
          </>
        ) : band.switchNote ? (
          <span className="text-[13px] text-ops-sub">
            {band.applyError
              ? 'AI 반영 오류가 있어 AI 확인을 다시 기다리는 중입니다'
              : `AI 확인이 끝나면 ${band.switchNote}`}
          </span>
        ) : (
          <span className="text-[13px] text-ops-sub">
            {band.time} 저장
            {band.applyError
              ? ' · AI 반영 오류가 있어 AI 확인을 다시 기다리는 중입니다'
              : ' · AI 확인이 끝나면 통화에 들어갑니다'}
          </span>
        )}
        {band.step === 'testing' && (
          <span className="ml-auto flex flex-wrap gap-2">
            {onProgress && <Btn onClick={onProgress}>진행 보기</Btn>}
            {band.canApply && (
              <Btn kind="danger" onClick={onStop}>
                시험 중단
              </Btn>
            )}
          </span>
        )}
      </div>
    )
  }
  const s = band.stopped
  const r = band.review
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-ops-wait/20 bg-ops-wait-soft px-7 py-3">
        {r ? (
          // 4번 확인 필요 (피그마 2368:5628) — 실패가 있으면 바로 반영하지 않고 담당자가 확인
          <>
            <Badge tone="wait">확인 필요</Badge>
            <span className="text-[15px] font-bold">시나리오 {r.fail}개 실패</span>
            <span className="text-[13px] text-ops-sub">{r.at} 시험</span>
          </>
        ) : s ? (
          <>
            <Badge tone="idle">시험 중단</Badge>
            <span className="text-[15px] font-bold">
              시나리오 {s.ended} / {s.total}에서 멈춤
            </span>
            <span className="text-[13px] text-ops-sub">{s.at} 시작</span>
          </>
        ) : (
          <>
            <Badge tone="wait">반영 전</Badge>
            <span className="text-[15px] font-bold">고친 내용</span>
            <span className="text-[13px] text-ops-sub">
              {band.time} 저장{band.author && ` · ${band.author}`}
            </span>
          </>
        )}
        {band.error && (
          <span role="alert" className="ml-auto text-[12px] text-ops-stop">
            {band.error}
          </span>
        )}
        <span className={`flex flex-wrap gap-2 ${band.error ? '' : 'ml-auto'}`}>
          {(s || r) && onProgress && (
            <Btn onClick={onProgress}>{r ? '실패한 시나리오 보기' : '지금까지 결과 보기'}</Btn>
          )}
          {band.canApply && (
            <Btn
              kind="line"
              disabled={busy}
              title={busy ? '고친 내용을 먼저 저장해 주세요' : undefined}
              onClick={r ? onReview : onApply}
            >
              {/* 6번(다른 상담가로 바꾸기)은 반영 대신 사용 · 다시 시험만 (통과해도 저절로 안 바꿈) */}
              {r
                ? band.switchNote
                  ? '확인하고 사용하기'
                  : '확인하고 반영'
                : s
                  ? band.switchNote
                    ? '다시 시험'
                    : '다시 시험하고 반영'
                  : '통화에 반영'}
            </Btn>
          )}
        </span>
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
