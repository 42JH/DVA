import { useLocation, useNavigate } from 'react-router'
import { Button, Dialog } from '@/shared/ui'
import { OrderChip } from './OrderChip'
import { PartyCard, PartyPair } from './PartyCards'
import { useOrderDetail, type PartyView } from './useOrderDetail'
import { KindChips, PendingChip } from '@/shared/ui/KindChips'

// 주문 상세 창 (03 주문 내역 · 06 '주문 보기' 같은 창) — Figma에 없어 새 디자인(11/04 '주문' · '통화')의 말투로 만든 모양 (11/04 사용자)
// 머리: '주문번호' + DV-00001 + 상태 칩(03 목록 줄과 같은 칩) · 접수 시각 · 경로 · 배송 n/m | ✕
// 몸: 보내는 분 ≫ 받는 분(하늘색 카드, 03 검색칸 사이 ≫와 같은 표시) · 접수 정보(두 칸) · 관련 통화(칩 = 04 통화 목록 색, 누르면 창을 닫고 06)
// 아래: [주문 취소](결제 전) … [닫기] [다시 접수](접수 실패) [수정] — 넘긴 곳에서만 보임 (06은 [닫기]만). 파랑 채움은 한 번에 하나
// 틀은 공용 새 디자인 창(shared/ui Dialog) — 머리 · 버튼 줄은 고정, 몸만 스크롤 (창 높이 = 화면 - 64까지)
// 쓰는 법: {orderId && <OrderDetailModal orderId={orderId} onClose={() => setOrderId(null)} onEdit={...} />}
export function OrderDetailModal({
  orderId,
  parcelSeq,
  onClose,
  onEdit,
  onCancel,
  onRetry,
}: {
  orderId: number
  parcelSeq?: number | null // 03 목록에서 누른 배송 상세 (없으면 첫 상세)
  onClose: () => void
  onEdit?: (orderSeq: number) => void
  onCancel?: (orderSeq: number, parcelCount: number) => void // 결제 전 주문만 보임 (11/01)
  onRetry?: (orderSeq: number) => void // 디버 접수 실패만 보임 (11/01)
}) {
  const navigate = useNavigate()
  const { pathname } = useLocation() // 06에서 열렸으면 지금 보는 통화는 링크 대신 글자 (같은 화면이 기록에 또 쌓이지 않게)
  const { order, isLoading, error } = useOrderDetail(orderId, parcelSeq)
  const retry = !!order?.canRetry && !!onRetry

  const openCall = (callSessionSeq: number) => {
    onClose()
    navigate(`/calls/${callSessionSeq}`)
  }

  return (
    <Dialog
      label="주문 상세"
      eyebrow={order ? '주문번호' : undefined}
      title={order?.orderNo ?? '주문 상세'}
      extra={order?.group && <OrderChip group={order.group} />}
      sub={order?.meta}
      onClose={onClose}
      footer={
        <>
          {order?.canCancel && onCancel && (
            <Button
              big
              kind="dangerLine"
              onClick={() => onCancel(order.orderSeq, order.parcelCount)}
            >
              주문 취소
            </Button>
          )}
          <Button big className="ml-auto" onClick={onClose}>
            닫기
          </Button>
          {retry && (
            <Button big kind="brand" onClick={() => onRetry(order.orderSeq)}>
              다시 접수
            </Button>
          )}
          {order?.canEdit && onEdit && (
            <Button big kind={retry ? 'brandLine' : 'brand'} onClick={() => onEdit(order.orderSeq)}>
              수정
            </Button>
          )}
        </>
      }
    >
      {!order ? (
        <p className="py-16 text-center text-body text-muted">
          {isLoading ? '불러오는 중…' : (error ?? '주문을 찾을 수 없습니다.')}
        </p>
      ) : (
        <>
          <PartyPair
            sender={<Party title="보내는 분" p={order.sender} />}
            receiver={<Party title="받는 분" p={order.receiver} />}
          />

          <section className="mt-5">
            <h3 className="text-strong font-bold">접수 정보</h3>
            <dl className="mt-3 grid grid-cols-2 gap-x-10 gap-y-3">
              {order.info.map(({ label, value, wide }) => (
                <div
                  key={label}
                  className={`flex items-baseline gap-4 ${wide ? 'col-span-2' : ''}`}
                >
                  <dt className="w-[116px] shrink-0 text-body text-sub">{label}</dt>
                  <dd
                    className={`min-w-0 text-strong break-words ${value === '없음' ? 'text-muted' : ''}`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="mt-5 border-t border-line pt-4">
            <h3 className="text-strong font-bold">관련 통화</h3>
            {order.relatedCalls.length === 0 ? (
              <p className="mt-3 text-body text-muted">없음</p>
            ) : (
              <ul className="mt-1">
                {order.relatedCalls.map((c) => (
                  <li
                    key={c.key}
                    className="flex h-12 items-center gap-5 border-b border-bg last:border-b-0"
                  >
                    <span className="w-[136px] shrink-0 text-body text-sub">{c.time}</span>
                    <span className="flex shrink-0 gap-2">
                      {c.analyzed ? <KindChips kinds={c.kinds} /> : <PendingChip />}
                    </span>
                    <span className="min-w-0 truncate text-strong">{c.text}</span>
                    {pathname === `/calls/${c.callSessionSeq}` ? (
                      <span className="ml-auto shrink-0 text-body text-sub">보고 있는 통화</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openCall(c.callSessionSeq)}
                        className="ml-auto shrink-0 text-body font-semibold text-brand hover:underline"
                      >
                        통화 상세 ›
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Dialog>
  )
}

/** 보내는 분 · 받는 분 카드 — 하늘색 바탕(틀 색) · 이름 20/600 · 전화번호 · 주소(도로명 + 상세) */
function Party({ title, p }: { title: string; p: PartyView }) {
  const dash = (t: string) => t || <span className="text-muted">—</span>
  return (
    <PartyCard title={title}>
      <p className="mt-1.5 text-card font-semibold break-words">{dash(p.name)}</p>
      <p className="mt-1 text-body">{dash(p.phone)}</p>
      <p className="mt-0.5 text-body break-words text-sub">{dash(p.address)}</p>
    </PartyCard>
  )
}
