import type { usePersonaPage } from '../hooks/usePersonaPage'
import { Badge, Btn, Segments } from '@/shared/ui'

type Vm = ReturnType<typeof usePersonaPage>
type Band = NonNullable<Vm['band']>

// 띠 모양 — 바탕은 뱃지(#fff4e0)보다 옅어 뱃지가 보임. 제목 16 · 흐린 글 14, 사이 12
const BAND = 'flex flex-wrap items-center gap-3 border-b border-[#f3e2c2] bg-[#fff9ef] px-7 py-3'
const TITLE = 'text-[16px] font-bold'
const DIM = 'text-[14px] text-ops-faint'

// 띠 — 반영 전 · 시험 중 · 반영 중 — 저장했지만 아직 통화에 안 쓰이는 버전이 있을 때
// 6번 — 다른 상담가로 바꾸기(switchNote): 시험 중 '통화에 쓰기 전 시험' · 반영 중 '통화에 들어가는 중'. 시험 통과 띠는 PassBand
// 2번 — 시험 중 [시험 중단] → 시험 중단: [지금까지 결과 보기] [다시 시험]
// [반영 전] 고친 내용 · 저장 시각 · 수정한 사람 | [통화에 반영]  /  아래 줄 토글: 고친 내용 ↔ 통화에 쓰는 내용
// 6번(다른 상담가로 바꾸기)은 반영 대신 사용 · 다시 시험만. 두 경우 모두 통과해도 저절로 반영하지 않음
const applyLabel = (band: Band) => {
  const switching = !!band.switchNote
  if (band.review) return switching ? '확인하고 사용하기' : '확인하고 반영'
  if (band.stopped) return '다시 시험'
  return '통화에 반영'
}
const waitTitle = (band: Band) => {
  const switching = !!band.switchNote
  if (band.step === 'testing') return switching ? '통화에 쓰기 전 시험' : '통화에 반영하기 전 시험'
  return switching ? '통화에 들어가는 중' : '고친 내용'
}
const waitNote = (band: Band) => {
  if (band.applyError) return 'AI 반영 오류가 있어 AI 확인을 다시 기다리는 중입니다'
  return band.switchNote
    ? `AI 확인이 끝나면 ${band.switchNote}`
    : 'AI 확인이 끝나면 통화에 들어갑니다'
}

// 시험 · 반영 중 — 버튼은 [진행 보기] [시험 중단]만(시험 중), 토글 없음
function WaitBand({
  band,
  onProgress,
  onStop,
}: {
  band: Band
  onProgress?: () => void
  onStop: () => void
}) {
  const p = band.progress
  return (
    <div className={BAND}>
      <Badge tone="wait">{band.step === 'testing' ? '시험 중' : '반영 중'}</Badge>
      <span className={TITLE}>{waitTitle(band)}</span>
      {p ? (
        <>
          <span className={DIM}>
            시나리오 {p.ended} / {p.total}
          </span>
          <progress
            value={p.ended}
            max={p.total || 1}
            aria-label="시험 진행"
            className="h-1.5 w-40 appearance-none overflow-hidden rounded-full bg-ops-idle-soft [&::-moz-progress-bar]:bg-ops-wait [&::-webkit-progress-bar]:bg-ops-idle-soft [&::-webkit-progress-value]:bg-ops-wait"
          />
          <span className={DIM}>통과 {p.pass}</span>
          {/* 0개도 빨강 (시나리오 시험 화면의 '실패 0'과 같게) */}
          <span className="text-[14px] text-ops-stop">실패 {p.fail}</span>
        </>
      ) : (
        <>
          {!band.switchNote && <span className={DIM}>{band.time} 저장</span>}
          <span className={DIM}>{waitNote(band)}</span>
        </>
      )}
      {band.step === 'testing' && (
        <span className="ml-auto flex flex-wrap gap-3">
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
  if (band.step === 'testing' || band.step === 'applying')
    return <WaitBand band={band} onProgress={onProgress} onStop={onStop} />
  const s = band.stopped
  const r = band.review
  return (
    <>
      <div className={BAND}>
        {r ? (
          // 4번 확인 필요 — 실패가 있으면 바로 반영하지 않고 담당자가 확인
          <>
            <Badge tone="wait">확인 필요</Badge>
            <span className={TITLE}>시나리오 {r.fail}개 실패</span>
            <span className={DIM}>{r.at} 시험</span>
          </>
        ) : s ? (
          <>
            <Badge tone="idle">시험 중단</Badge>
            <span className={TITLE}>
              시나리오 {s.ended} / {s.total}에서 멈춤
            </span>
            {/* 시안은 멈춘 때 · 멈춘 사람 — 창구가 주지 않아 시작한 때 */}
            <span className={DIM}>{s.at} 시작</span>
          </>
        ) : (
          <>
            <Badge tone="wait">반영 전</Badge>
            <span className={TITLE}>고친 내용</span>
            <span className={DIM}>{band.time} 저장</span>
            {band.author && <span className={DIM}>{band.author}</span>}
          </>
        )}
        {band.error && (
          <span role="alert" className="ml-auto text-[12px] text-ops-stop">
            {band.error}
          </span>
        )}
        <span className={`flex flex-wrap gap-3 ${band.error ? '' : 'ml-auto'}`}>
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
              {applyLabel(band)}
            </Btn>
          )}
        </span>
      </div>
      {band.canCompare && (
        <div className="flex border-b border-ops-line px-7 py-3">
          {/* 회색 받침 위 토글 — 흰 카드 위에 글자만 있으면 눌리는 곳으로 안 보임 */}
          <div className="rounded-lg bg-ops-idle-soft p-1">
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
        </div>
      )}
    </>
  )
}
