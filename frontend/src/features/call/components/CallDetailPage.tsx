import { useParams } from 'react-router'
import { OrderDetailModal } from '@/shared/order/OrderDetailModal'
import { Tag } from '@/shared/ui'
import { useCallDetail } from '@/features/call/hooks/useCallDetail'
import { CallActions } from './CallActions'
import { CallScript } from './CallScript'

// 06 통화 상세 (와이어프레임 06_통화상세 · _주문취소 · _문의 · _주문상세, 10/30)
// 위 요약 카드: 고객 + 통화 결과 · 통화 시작 시각 · 통화 시간 · 발신번호 (+ 불만 줄) / 왼쪽 통화 스크립트 598 / 오른쪽 처리 내용
// 통화 ≠ 주문 (10/28): 송장 칸 · 수정은 06에 없음. 주문은 '주문 보기 ›' 팝업으로만
export function CallDetailPage() {
  const { callId } = useParams()
  // 라우트는 하나(calls/:callId)라 통화가 바뀌어도(팝업의 관련 통화 · 뒤로가기) 언마운트되지 않음 → key로 다시 마운트해 팝업 · 재생 속도 · 플레이어를 초기화
  return <CallDetailBody key={callId} callId={Number(callId)} />
}

function CallDetailBody({ callId }: { callId: number }) {
  const vm = useCallDetail(callId)

  if (vm.error) return <p className="py-16 text-center text-body text-muted">{vm.error}</p>
  if (vm.isLoading || !vm.summary)
    return <p className="py-16 text-center text-body text-muted">불러오는 중…</p>

  const s = vm.summary
  return (
    // 두 카드가 화면 바닥까지 (카드 안에서만 스크롤). 창이 낮으면 최소 760 높이로 두고 페이지가 스크롤
    <div className="flex min-h-[760px] flex-1 flex-col gap-6">
      {/* 요약: 칸 폭은 내용대로, 사이 간격은 같게. 세로선으로 칸 구분 */}
      <section className="shrink-0 rounded-xl bg-surface px-8 ring-1 ring-line ring-inset">
        <div className="flex items-start justify-between gap-8 py-6 whitespace-nowrap">
          {(
            [
              ['고객', s.customer],
              ['통화 시작 시각', s.startedAt],
              ['통화 시간', s.duration],
              ['발신번호', s.caller],
            ] as const
          ).map(([label, value], i) => (
            <div
              key={label}
              className={`flex flex-col gap-1.5 ${i ? 'border-l border-line pl-8' : 'min-w-0'}`} // 고객 칸만 줄어들 수 있게 — 긴 이름은 말줄임 (11/02)
            >
              <span className="text-label text-sub">{label}</span>
              <span
                className={`flex min-w-0 items-center gap-2 text-strong ${i ? 'font-semibold' : 'font-bold'}`}
              >
                <span className="truncate" title={value}>
                  {value}
                </span>
                {i === 0 && (
                  <span className="shrink-0">
                    <Tag kind={s.outcomeTag}>{s.outcome}</Tag>
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
        {s.complaints.length > 0 && (
          // 불만이 감지된 통화만: 가는 줄 아래 '불만 [유형] 감지 사유' (04 불만 열과 같은 내용)
          <div className="flex min-h-[52px] flex-wrap items-center gap-4 border-t border-line py-2 text-body">
            <span className="text-label text-sub">불만</span>
            {s.complaints.map((c, i) => (
              <span key={i} className="flex items-center gap-2.5">
                <Tag kind="red">{c.label}</Tag>
                {c.reason}
              </span>
            ))}
          </div>
        )}
      </section>

      <div className="flex min-h-0 flex-1 items-stretch gap-6">
        <CallScript
          className="w-[598px] shrink-0"
          persona={vm.persona}
          player={vm.player}
          audioRef={vm.audioRef}
          segments={vm.segments}
          focusKey={vm.focusKey}
          jump={vm.jump}
        />
        <CallActions
          className="min-w-0 flex-1"
          results={vm.results}
          actions={vm.actions}
          count={vm.actionCount}
        />
      </div>

      {vm.orderId !== null && <OrderDetailModal orderId={vm.orderId} onClose={vm.closeOrder} />}
    </div>
  )
}
