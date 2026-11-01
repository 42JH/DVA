import { useNavigate } from 'react-router'
import { Button, FormModal, Tag } from '@/shared/ui'
import { useOrderDetail } from './useOrderDetail'

// 주문 상세 팝업 (디자인 03_주문내역_주문상세 · _전화 = 06 '주문 보기'와 같은 창, 10/30 공통으로 올림)
// 보내는 분 | 받는 분 → 접수 정보 → 관련 통화(누르면 창을 닫고 그 통화의 06) · [닫기] [수정]. 읽기 전용
// 쓰는 법: {orderId && <OrderDetailModal orderId={orderId} onClose={() => setOrderId(null)} onEdit={...} />}
//   onEdit을 넘긴 곳에서만 [수정]이 보임 (취소된 주문은 늘 없음). 주문 수정 화면은 03(팀원) 몫
export function OrderDetailModal({
  orderId,
  parcelSeq,
  onClose,
  onEdit,
}: {
  orderId: number
  parcelSeq?: number | null // 03 목록에서 누른 배송 상세 (없으면 첫 상세)
  onClose: () => void
  onEdit?: (orderSeq: number) => void
}) {
  const navigate = useNavigate()
  const { order, isLoading, error } = useOrderDetail(orderId, parcelSeq)

  const openCall = (callSessionSeq: number) => {
    onClose()
    navigate(`/calls/${callSessionSeq}`)
  }

  return (
    <FormModal
      title="주문 상세"
      titleExtra={order?.tags.map((t) => (
        <Tag key={t.label} kind={t.kind}>
          {t.label}
        </Tag>
      ))}
      description={order?.subtitle}
      width={960}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>닫기</Button>
          {order?.canEdit && onEdit && (
            <Button kind="primary" onClick={() => onEdit(order.orderSeq)}>
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
          <div className="grid grid-cols-2">
            <Section title="보내는 분" rows={order.sender} />
            <Section title="받는 분" rows={order.receiver} className="border-l border-line pl-7" />
          </div>

          <div className="border-t border-line" />
          <div>
            <h3 className="mb-3 text-body font-bold">접수 정보</h3>
            <Row label="품목" value={order.items} />
            <div className="grid grid-cols-2">
              {order.info.map(([label, value]) => (
                <Row key={label} label={label} value={value} />
              ))}
            </div>
            <Row label="고객 요청 사항" value={order.clientComment} />
          </div>

          <div className="border-t border-line" />
          <div>
            <h3 className="mb-3 text-body font-bold">관련 통화</h3>
            {order.relatedCalls.length === 0 ? (
              <p className="text-body text-muted">없음</p>
            ) : (
              <ul>
                {order.relatedCalls.map((c) => (
                  <li key={c.key} className="flex h-12 items-center gap-6 text-body">
                    <span>{c.time}</span>
                    <Tag kind="gray">{c.tag}</Tag>
                    <span>{c.text}</span>
                    <button
                      type="button"
                      onClick={() => openCall(c.callSessionSeq)}
                      className="ml-auto text-label font-semibold text-action hover:underline"
                    >
                      통화 상세 ›
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </FormModal>
  )
}

function Section({
  title,
  rows,
  className = '',
}: {
  title: string
  rows: [string, string][]
  className?: string
}) {
  return (
    <div className={className}>
      <h3 className="mb-3 text-body font-bold">{title}</h3>
      {rows.map(([label, value]) => (
        <Row key={label} label={label} value={value} />
      ))}
    </div>
  )
}

/** 항목 136 · 값 (없음 · — 은 회색) */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <p className="flex h-12 items-center">
      <span className="w-[136px] shrink-0 text-label text-sub">{label}</span>
      <span className={`text-body ${value === '없음' || value === '—' ? 'text-sub' : ''}`}>
        {value}
      </span>
    </p>
  )
}
