import { useLocation, useParams } from 'react-router'
import { OrderDetailModal } from '@/shared/order/OrderDetailModal'
import { Crumbs, TopBar } from '@/shared/ui'
import { useCallDetail } from '@/features/call/hooks/useCallDetail'
import { CallActions } from './CallActions'
import { CallScript } from './CallScript'
import { KindChips, PendingChip } from '@/shared/ui/KindChips'

// 06 통화 상세 — Figma에 새 디자인이 없어 새 화면(11/04 'FAQ 상세' · '통화')의 말투로 만든 모양 (11/05 사용자)
// 경로 '통화 > 통화 상세'(04 목록에서 왔으면 그 목록으로) · 머리: 고객 이름(신규면 new) + 상담 유형 칩(04 줄과 같은 칩)
//   아래 한 줄 발신번호 · 시작 시각 · 통화 시간 · 상담가, 불만이면 빨간 알약 + 고객이 한 말 · 구분선
// 몸: 왼쪽 통화 스크립트(녹취 재생 + 말풍선 — Figma 'chat-log': AI 왼쪽 회색 · 고객 오른쪽 파랑) | 오른쪽 처리 내용 + AI 동작
// 한 화면에: 머리는 고정, 말풍선 · AI 동작만 각자 스크롤. 통화 ≠ 주문 (10/28): 주문은 '주문 보기 ›' 팝업으로만
export function CallDetailPage() {
  const { callId } = useParams()
  // 라우트는 하나(calls/:callId)라 통화가 바뀌어도(팝업의 관련 통화 · 뒤로가기) 언마운트되지 않음 → key로 다시 마운트해 팝업 · 플레이어를 초기화
  return <CallDetailBody key={callId} callId={Number(callId)} />
}

const PAD = 'pr-[50px] pl-[58px]' // 04 목록 머리와 같은 좌우 자리

function CallDetailBody({ callId }: { callId: number }) {
  const vm = useCallDetail(callId)
  // 04 목록에서 왔으면 그 주소(날짜 · 검색 · 필터 그대로)로, 다른 곳(주문 상세 · AI 미답변)에서 왔으면 오늘 목록으로
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/calls'
  const s = vm.summary

  return (
    <div className="flex min-h-0 flex-[1_1_0px] flex-col">
      <TopBar search={{ tab: 'call' }} />
      <Crumbs
        items={[{ label: '통화', to: from }, { label: '통화 상세' }]}
        className="shrink-0 pl-[58px]"
      />
      {vm.error || !s ? (
        <p className="py-16 text-center text-body text-muted">{vm.error ?? '불러오는 중…'}</p>
      ) : (
        <>
          <header className={`mt-v32 shrink-0 ${PAD}`}>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <h1 className="flex min-w-0 items-start text-title font-semibold">
                <span className="truncate" title={s.customer}>
                  {s.customer}
                </span>
                {s.isNew && (
                  <sup className="mt-1.5 ml-1 text-[12px] font-normal text-brand">new</sup>
                )}
              </h1>
              <span className="flex flex-wrap items-center gap-2 text-card">
                {s.analyzed ? <KindChips kinds={s.kinds} /> : <PendingChip />}
              </span>
            </div>
            <p className="mt-1.5 text-body text-sub">
              {[s.caller, `${s.startedAt} 시작`, s.duration, vm.persona && `상담가 ${vm.persona}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {s.complaints.map((c, i) => (
              // 불만이 감지된 통화만 — 04에선 알약에 올려야 보이던 고객이 한 말을 그대로 (스크립트의 빨간 묶음과 같은 유형)
              <p key={i} className="mt-2.5 flex items-center gap-3 text-body">
                <span className="inline-flex h-7 shrink-0 items-center rounded-xl bg-danger px-3 font-bold text-white">
                  {c.label}
                </span>
                <span className="min-w-0 break-words text-sub">{c.reason}</span>
              </p>
            ))}
          </header>
          <div className="mt-v24 mr-[50px] ml-[58px] shrink-0 border-t border-line" />
          {vm.notice && (
            <p role="status" className={`shrink-0 pt-2 text-caption text-muted ${PAD}`}>
              {vm.notice}
            </p>
          )}
          <div className={`mt-v24 flex min-h-0 flex-1 gap-12 ${PAD}`}>
            <CallScript
              className="min-w-0 flex-[3]"
              player={vm.player}
              audioRef={vm.audioRef}
              segments={vm.segments}
              focusKey={vm.focusKey}
              jump={vm.jump}
              emptyText={vm.scriptEmpty}
            />
            <CallActions
              className="min-w-0 flex-[2]"
              results={vm.results}
              actions={vm.actions}
              count={vm.actionCount}
              resultsEmpty={vm.resultsEmpty}
              actionsEmpty={vm.actionsEmpty}
            />
          </div>
        </>
      )}

      {vm.orderId !== null && <OrderDetailModal orderId={vm.orderId} onClose={vm.closeOrder} />}
    </div>
  )
}
