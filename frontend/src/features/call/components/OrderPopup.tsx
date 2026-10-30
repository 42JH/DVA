import { Button, FormModal, Tag } from '@/shared/ui'
import type { OrderView } from '@/features/call/hooks/useCallDetail'

// 주문 상세 팝업 (와이어프레임 06_통화상세_주문상세 · _주문취소_주문상세, 10/30) — 06 '주문 보기 ›'를 누르면 06 위에 뜸
// 03 주문 상세와 같은 내용 · 읽기 전용: 보내는 분 | 받는 분 → 접수 정보 → 관련 통화(누르면 그 통화 06). 취소된 주문은 [닫기]만
// 03(팀원)이 주문 상세를 만들면 app 층에서 그 화면으로 바꿔 끼움 (feature끼리 import 금지 → 지금은 06이 직접 가짐, 10/30 A안)
export function OrderPopup({
  order,
  onClose,
  onEdit,
}: {
  order: OrderView
  onClose: () => void
  onEdit: () => void
}) {
  return (
    <FormModal
      title={order.title}
      titleExtra={order.tags.map((t) => (
        <Tag key={t.label} kind={t.kind}>
          {t.label}
        </Tag>
      ))}
      description={order.subtitle}
      width={960}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>닫기</Button>
          {order.canEdit && (
            <Button kind="primary" onClick={onEdit}>
              수정
            </Button>
          )}
        </>
      }
    >
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
                  onClick={c.onClick}
                  className="ml-auto text-label font-semibold text-action hover:underline"
                >
                  통화 상세 ›
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
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
