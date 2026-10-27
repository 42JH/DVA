import { useParams } from 'react-router'
import { Tag } from '@/shared/ui'
import { useCallDetail } from '@/features/call/hooks/useCallDetail'
import { CallResult } from './CallResult'
import { CallScript } from './CallScript'

// 06 통화 상세 (와이어프레임 06_통화상세) — 위 요약 한 줄 카드 / 왼쪽 통화 스크립트 598 / 오른쪽 통화 결과
export function CallDetailPage() {
  const { callId } = useParams()
  const vm = useCallDetail(Number(callId))

  return (
    <div className="flex flex-col gap-6">
      {vm.error ? (
        <p className="py-16 text-center text-body text-muted">{vm.error}</p>
      ) : vm.isLoading || !vm.summary ? (
        <p className="py-16 text-center text-body text-muted">불러오는 중…</p>
      ) : (
        <>
          {/* 요약: 칸 폭은 내용대로, 사이 간격은 같게. 세로선으로 칸 구분 */}
          <section className="rounded-xl bg-surface px-8 ring-1 ring-line ring-inset">
            <div className="flex items-start justify-between gap-8 py-6 whitespace-nowrap">
              {[
                ['주문 번호', vm.summary.orderNo, vm.summary.outcome],
                ['디버 접수번호', vm.summary.parcelNo],
                ['통화 시작 시각', vm.summary.startedAt],
                ['통화 시간', vm.summary.duration],
                ['발신번호', vm.summary.caller],
                ['페르소나', vm.summary.persona],
              ].map(([label, value, tag], i) => (
                <div
                  key={label}
                  className={`flex flex-col gap-1.5 ${i ? 'border-l border-line pl-8' : ''}`}
                >
                  <span className="text-label text-sub">{label}</span>
                  <span
                    className={`flex items-center gap-2 text-strong ${i ? 'font-semibold' : 'font-bold'}`}
                  >
                    {value}
                    {tag && (
                      <Tag
                        kind={tag === '접수 성공' ? 'blue' : tag === '접수 실패' ? 'red' : 'gray'}
                      >
                        {tag}
                      </Tag>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {vm.summary.complaints.length > 0 && (
              // 불만이 감지된 통화만: 가는 줄 아래 '불만 [유형] 감지 사유' (04 불만 열과 같은 내용)
              <div className="flex h-[52px] items-center gap-4 border-t border-line text-body">
                <span className="text-label text-sub">불만</span>
                {vm.summary.complaints.map((c, i) => (
                  <span key={i} className="flex items-center gap-2.5">
                    <Tag kind="red">{c.kind}</Tag>
                    {c.reason}
                  </span>
                ))}
              </div>
            )}
          </section>

          {/* 두 카드 높이 맞춤 (와이어프레임: 둘 다 바닥까지) */}
          <div className="flex items-stretch gap-6">
            <CallScript
              className="w-[598px] shrink-0"
              showActions={vm.showActions}
              onToggleActions={vm.setShowActions}
              player={vm.player}
              segments={vm.segments}
            />
            <CallResult
              className="min-w-0 flex-1"
              hasOrder={vm.hasOrder}
              sections={vm.sections}
              editing={vm.editing}
              onStartEdit={vm.startEdit}
              onEditValue={vm.setEditValue}
              onCancel={vm.cancelEdit}
              onSave={vm.saveEdit}
              isSaving={vm.isSaving}
              saveError={vm.saveError}
            />
          </div>
        </>
      )}
    </div>
  )
}
