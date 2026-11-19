// 주문 상세 패널: 목록 오른쪽에 붙음 (모달 이동 줄이기, 기업 피드백)
// 송장처럼 줄 친 표(주문번호 · 보내는 분 · 받는 분 · 물품 · 요금 · 결제 · 수거 · 요청). 미완료면 빈 필수 칸을 노랗게. 이어진 통화는 주문 목록 자리에 띄움
import { useState, type ReactNode } from 'react'
import { WaybillEdit } from './WaybillEdit'
import { Badge, Btn, Icon, Kinds } from '@/shared/ui'
import { useEscape } from '@/shared/lib/keys'
import { useWaybill, type Waybill } from '../hooks/useWaybill'
import type { LinkedCall } from './CallOverlay'
import { Confirm } from '@/shared/ui/Modal'

export function WaybillPanel({
  orderSeq,
  parcelSeq,
  onClose,
  openCall,
  onOpenCall,
  onMoved,
  initialNotice = null,
}: {
  orderSeq: number
  parcelSeq: number | null
  onClose: () => void
  openCall: number | null // 목록 자리에 띄운 통화
  onOpenCall: (call: LinkedCall) => void
  onMoved: (orderSeq: number, notice?: string) => void // 미완료(초안)를 접수해 새 주문이 생기면 그 주문으로
  initialNotice?: string | null
}) {
  const w = useWaybill(orderSeq, parcelSeq)
  useEscape(onClose)
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(initialNotice) // 미완료 주문 접수 결과
  const v = w.view

  let body: ReactNode
  if (!v)
    body = w.error ? (
      <p className="py-10 text-center text-[14px] text-ops-sub">{w.error}</p>
    ) : (
      <PanelSkeleton />
    )
  else if (editing)
    // 수정은 그 자리에서 — 상세와 같은 칸, 저장 · 취소하면 상세로
    body = (
      <WaybillEdit
        orderSeq={orderSeq}
        parcelSeq={parcelSeq}
        fee={v.fee}
        onDone={(notice, newOrderSeq) => {
          setEditing(false)
          if (newOrderSeq) onMoved(newOrderSeq, notice)
          else setNotice(notice ?? null)
        }}
      />
    )
  else
    body = (
      <>
        {notice && (
          <p
            role="status"
            className="mb-3 rounded-md bg-ops-route-soft px-3 py-2 text-[13px] text-ops-route"
          >
            {notice}
          </p>
        )}
        {w.missing.size > 0 && <MissingNote w={w} />}
        <Slip w={w} />
        <Calls calls={v.calls} openCall={openCall} onOpen={onOpenCall} />
      </>
    )

  return (
    <aside
      aria-label="주문 상세"
      className="flex w-[440px] shrink-0 flex-col border-l border-ops-line bg-white max-xl:w-[380px]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-ops-line px-5">
        {/* 위 줄은 이름 · 닫기만 — 상태는 송장 안 주문번호 옆 */}
        <h2 className="text-[13px] font-semibold text-ops-sub">주문 상세</h2>
        {v?.position && <span className="text-[12px] text-ops-sub">{v.position}</span>}
        <button
          type="button"
          onClick={onClose}
          aria-label="상세 닫기"
          className="ml-auto grid size-8 place-items-center rounded-md text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
        >
          <Icon name="x" />
        </button>
      </div>

      <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-5 py-4">{body}</div>

      {v && !editing && <Actions w={w} onEdit={() => setEditing(true)} onClose={onClose} />}
    </aside>
  )
}

/** 아래 버튼 줄 [수정] [디버에 다시 접수] [삭제 · 주문 취소] + 확인 창 둘 */
function Actions({ w, onEdit, onClose }: { w: Waybill; onEdit: () => void; onClose: () => void }) {
  const v = w.view!
  const [asking, setAsking] = useState(false)
  const [askingRetry, setAskingRetry] = useState(false) // [디버에 다시 접수] 확인 창
  return (
    <>
      {(w.canEdit || w.canCancel || w.canRetry) && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-ops-line px-5 py-3">
          <div className="flex items-center gap-2">
            {w.canEdit && (
              <Btn kind="edit" onClick={onEdit}>
                수정
              </Btn>
            )}
            {w.canRetry && (
              <Btn disabled={w.busy} onClick={() => setAskingRetry(true)}>
                디버에 다시 접수
              </Btn>
            )}
            {w.canCancel && (
              <Btn kind="danger" className="ml-auto" onClick={() => setAsking(true)}>
                {v.isDraft ? '삭제' : '주문 취소'}
              </Btn>
            )}
          </div>
          {w.actionError && <p className="text-[12px] text-ops-stop">{w.actionError}</p>}
          {w.retryNotice && (
            <p
              role="status"
              className={`text-[12px] ${w.retryNotice.tone === 'stop' ? 'text-ops-stop' : 'text-ops-wait'}`}
            >
              {w.retryNotice.text}
            </p>
          )}
        </div>
      )}
      {/* 결과 저장만 실패했으면 디버엔 이미 접수됐을 수 있음 → 디버 쪽을 먼저 보라고 (orderApi retryOrder 주석) */}
      {askingRetry && w.canRetry && (
        <Confirm
          title="디버에 다시 접수할까요?"
          ok="다시 접수"
          busy={w.busy}
          error={w.actionError}
          onOk={() => w.retry(() => setAskingRetry(false))}
          onClose={() => setAskingRetry(false)}
        >
          <b className="font-semibold">{v.no}</b> 주문을 지금 저장된 내용으로 디버에 다시 보냅니다.
          다시 결제하지 않습니다. 디버에 이미 접수돼 있을 수 있으니 디버 쪽을 먼저 확인해 주세요.
        </Confirm>
      )}
      {asking && w.canCancel && (
        <Confirm
          title={v.isDraft ? '미완료 주문을 삭제할까요?' : '주문을 취소할까요?'}
          ok={v.isDraft ? '삭제' : '주문 취소'}
          closeLabel="닫기"
          danger
          busy={w.busy}
          error={w.actionError}
          onOk={() => w.cancel(v.isDraft ? onClose : undefined)}
          onClose={() => setAsking(false)}
        >
          {v.isDraft ? (
            <>
              <b className="font-semibold">{v.no}</b> 미완료 주문을 목록에서 지웁니다. 접수된
              주문이나 결제와는 상관없습니다.
            </>
          ) : (
            <>
              <b className="font-semibold">{v.no}</b> 주문을 취소합니다. 되돌릴 수 없습니다.
            </>
          )}
        </Confirm>
      )}
    </>
  )
}

const MISSING_LABEL: Record<string, string> = {
  'sender.name': '보내는 분 이름',
  'sender.phone': '보내는 분 전화번호',
  'sender.address': '보내는 분 주소',
  'receiver.name': '받는 분 이름',
  'receiver.phone': '받는 분 전화번호',
  'receiver.address': '받는 분 주소',
  items: '물품',
  itemPrice: '물품 가액',
  payMethod: '결제 방식',
}

/** 미완료 사유 — AI 통화가 끊겨 아직 비어 있는 칸 (기업 피드백: 미완료면 사유가 보여야 함) */
function MissingNote({ w }: { w: Waybill }) {
  return (
    <div className="mb-4 flex gap-2.5 rounded-lg bg-ops-wait-soft px-3.5 py-3 text-ops-wait">
      <Icon name="alert" className="mt-0.5 size-4" />
      <div className="text-[13px] leading-5">
        <p className="font-semibold">접수하려면 {w.missing.size}칸을 더 채워야 합니다</p>
        <p className="text-ops-ink/80">{[...w.missing].map((k) => MISSING_LABEL[k]).join(', ')}</p>
      </div>
    </div>
  )
}

/** 운송장 본체 — 택배 송장처럼 줄 친 표: 왼쪽 칸 이름 · 오른쪽 값. 빈 필수 칸은 노랗게 */
function Slip({ w }: { w: Waybill }) {
  const v = w.view!
  const miss = (k: string) => w.missing.has(k)
  const party = (side: 'sender' | 'receiver') => {
    const p = v[side]
    const m = (f: string) => miss(`${side}.${f}`)
    return (
      <>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[15px] font-semibold">
            <Val missing={m('name')}>{p.name}</Val>
          </span>
          <span className="text-[13px] text-ops-sub tabular-nums">
            <Val missing={m('phone')}>{p.phone}</Val>
          </span>
        </p>
        <p className="mt-0.5 text-[13px] leading-5">
          <Val missing={m('address')}>{[p.address, p.detail].filter(Boolean).join(' ')}</Val>
        </p>
      </>
    )
  }
  return (
    <article className="overflow-hidden rounded-md border border-ops-ink/25 text-ops-ink">
      <header className="flex items-end justify-between gap-3 border-b border-ops-ink/25 px-3 py-2.5">
        <div>
          <p className="text-[11px] font-medium text-ops-sub">주문번호</p>
          <p className="flex items-center gap-2">
            <span className="text-[22px] leading-7 font-bold tracking-wide tabular-nums">
              {v.no}
            </span>
            {v.look && <Badge tone={v.look.tone}>{v.look.label}</Badge>}
          </p>
        </div>
        <p className="pb-0.5 text-right text-[12px] leading-4 text-ops-sub">
          <span className="block tabular-nums">{v.acceptedAt}</span>
          <span className="block">{v.route}</span>
        </p>
      </header>
      <dl className="grid grid-cols-[64px_1fr_64px_1fr] [&>*]:border-b [&>*]:border-ops-line [&>*:nth-last-child(-n+2)]:border-b-0">
        <Row
          label="보내는 분"
          missing={['name', 'phone', 'address'].some((f) => miss(`sender.${f}`))}
        >
          {party('sender')}
        </Row>
        <Row
          label="받는 분"
          missing={['name', 'phone', 'address'].some((f) => miss(`receiver.${f}`))}
        >
          {party('receiver')}
        </Row>
        <Row label="물품" missing={miss('items')}>
          {v.items}
        </Row>
        <Row label="물품 가액" half="left" missing={miss('itemPrice')}>
          {v.itemPrice}
        </Row>
        <Row label="배송비" half="right">
          {v.fee}
        </Row>
        <Row label="결제 방식" half="left" missing={miss('payMethod')}>
          {v.payMethod}
        </Row>
        <Row label="결제" half="right">
          {v.payState}
        </Row>
        <Row label="수거 희망">{v.pickupAt}</Row>
        <Row label="요청 사항">{v.comment}</Row>
      </dl>
    </article>
  )
}

/** 송장 한 칸 = 이름 칸 + 값 칸. half면 한 줄에 둘 (left 오른쪽에 세로줄) */
function Row({
  label,
  half,
  missing = false,
  children,
}: {
  label: string
  half?: 'left' | 'right'
  missing?: boolean
  children: ReactNode
}) {
  return (
    <>
      <dt
        className={`flex items-start border-r border-ops-line px-2.5 py-2 text-[12px] leading-5 font-medium text-ops-sub ${missing ? 'bg-ops-wait-soft text-ops-wait' : 'bg-ops-paper'}`}
      >
        {label}
      </dt>
      <dd
        className={`min-w-0 px-3 py-2 text-[14px] leading-5 font-medium break-words ${half ? '' : 'col-span-3'} ${half === 'left' ? 'border-r border-ops-line' : ''}`}
      >
        {children === '' || children == null ? (
          <Val missing={missing}>
            <span className="font-normal text-ops-faint">없음</span>
          </Val>
        ) : (
          <Val missing={missing && typeof children === 'string'}>{children}</Val>
        )}
      </dd>
    </>
  )
}

/** 빈 필수 칸 = 노란 '입력 필요' */
function Val({ missing, children }: { missing: boolean; children: ReactNode }) {
  if (missing)
    return (
      <span className="rounded bg-ops-wait-soft px-1.5 text-[12px] font-semibold text-ops-wait">
        입력 필요
      </span>
    )
  return <>{children}</>
}

/** 이 주문과 이어진 통화 — 누르면 주문 목록 자리에 대화 창이 뜸 (화면을 옮기지 않음) */
function Calls({
  calls,
  openCall,
  onOpen,
}: {
  calls: LinkedCall[]
  openCall: number | null
  onOpen: (call: LinkedCall) => void
}) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 text-[13px] font-semibold text-ops-sub">이어진 통화</h2>
      {calls.length === 0 ? (
        <p className="text-[13px] text-ops-faint">이어진 통화가 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {calls.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                aria-pressed={openCall === c.seq}
                onClick={() => onOpen(c)}
                className="flex w-full items-center gap-3 rounded-md border border-ops-line px-3 py-2.5 text-left hover:border-ops-route hover:bg-ops-route-soft/40 aria-pressed:border-ops-route aria-pressed:bg-ops-route-soft"
              >
                <Icon name="phone" className="size-4 text-ops-sub" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">
                    #{c.seq} {c.what}
                  </span>
                  <span className="block text-[12px] text-ops-sub">{c.at}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {c.analyzed ? <Kinds kinds={c.kinds} /> : <Badge tone="idle">분석 중</Badge>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 상세를 받는 동안 — 운송장 자리 모양 */
function PanelSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-3 motion-safe:animate-pulse">
      <div className="h-24 rounded-md bg-ops-idle-soft" />
      <div className="h-28 rounded-md bg-ops-idle-soft" />
      <div className="h-40 rounded-md bg-ops-idle-soft" />
    </div>
  )
}
