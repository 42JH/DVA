// 통화 상세 오른쪽 — 운영팀용 정보(고객 · 이 통화의 주문 · 처리 결과 · 불만). 왼쪽 대화는 CallPage
import { useRef, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useCallOrder } from '../hooks/useCallOrder'
import { orderNo, priceBand } from '@/shared/order/labels'
import { fmtPhone } from '@/shared/lib/format'
import { Badge } from '@/shared/ui'
import { itemsText, STATUS_LOOK, won } from '@/shared/order/look'
import { dateTime } from '@/shared/lib/when'
import { type CallView } from '../hooks/useCallView'
import { useKeepScroll } from '@/shared/lib/keepScroll'

type Summary = NonNullable<CallView['summary']>

/** 오른쪽 운영팀용 정보 — 고객 · 주문 · 처리 결과 · 불만 (한 화면에 다 보여 목차는 두지 않음) */
export function Contents({ vm }: { vm: CallView }) {
  const summary = vm.summary
  const side = useRef<HTMLDivElement>(null)
  useKeepScroll(side, 'side')
  return (
    <aside
      aria-label="통화 정보"
      className="flex w-[400px] shrink-0 flex-col border-l border-ops-line bg-white max-xl:w-[340px]"
    >
      <div
        ref={side}
        className="relative min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-5 py-4"
      >
        {summary ? (
          <div className="flex flex-col gap-6">
            <CustomerSection summary={summary} />
            <OrdersSection summary={summary} />
            <ResultsSection summary={summary} />
            <ComplaintSections summary={summary} />
          </div>
        ) : (
          <p className="text-[13px] text-ops-sub">불러오는 중…</p>
        )}
      </div>
    </aside>
  )
}

/** 비어 있는 칸의 문구 — 분석 전이면 기다리라고(분석 실패면 받지 못했다고), 판정 전이면 그렇게, 아니면 '없음' 문구 */
function emptyText(summary: Summary, none: string, judged = false) {
  if (!summary.analyzed)
    return summary.state.label === '분석 실패'
      ? '분석을 받지 못했습니다.'
      : '분석이 끝나면 보입니다.'
  if (judged && summary.judging) return '아직 분석 전입니다.'
  return none
}

/** 고객 — 이름(없으면 미등록 발신자) · 전화 · 소속 · 신규 여부 · 요청 */
function CustomerSection({ summary }: { summary: Summary }) {
  return (
    <Section id="customer" title={summary.name ? '고객' : '발신자'}>
      <dl className="grid grid-cols-[72px_1fr] gap-y-1.5 text-[13px]">
        {summary.name ? (
          <>
            <dt className="text-ops-sub">이름</dt>
            <dd className="font-medium">{summary.name}</dd>
          </>
        ) : (
          <>
            <dt className="text-ops-sub">고객 정보</dt>
            <dd className="text-ops-sub">등록되지 않은 번호</dd>
          </>
        )}
        <dt className="text-ops-sub">전화번호</dt>
        <dd className="tabular-nums">{summary.phone}</dd>
        {/* 모르는 값은 '모름' 대신 줄을 뺌 — 미등록 발신자는 소속이 없고, 신규 여부는 분석 뒤에 옴 */}
        {summary.member && (
          <>
            <dt className="text-ops-sub">소속</dt>
            <dd>{summary.member}</dd>
          </>
        )}
        {summary.isNew !== null && (
          <>
            <dt className="text-ops-sub">구분</dt>
            <dd>{summary.isNew ? '신규 고객' : '기존 고객'}</dd>
          </>
        )}
        {summary.asks.length > 0 && (
          <>
            <dt className="text-ops-sub">요청</dt>
            <dd className="text-ops-wait">{summary.asks.join(', ')}</dd>
          </>
        )}
      </dl>
    </Section>
  )
}

/** 이 통화에서 접수 · 취소한 주문 */
function OrdersSection({ summary }: { summary: Summary }) {
  return (
    <Section id="orders" title="주문">
      {summary.orders.length === 0 ? (
        <Muted>{emptyText(summary, '이 통화에서 접수하거나 취소한 주문이 없습니다.')}</Muted>
      ) : (
        <div className="flex flex-col gap-2">
          {summary.orders.map((order) => (
            <OrderCard key={order.seq} seq={order.seq} what={order.what} />
          ))}
        </div>
      )}
    </Section>
  )
}

/** 처리 결과 — 한 일 · 주문번호 · 못 한 이유 · 고객 질문 */
function ResultsSection({ summary }: { summary: Summary }) {
  return (
    <Section id="results" title="처리 결과">
      {summary.results.length === 0 ? (
        <Muted>{emptyText(summary, '처리한 일이 없습니다.')}</Muted>
      ) : (
        <ul className="flex flex-col gap-1.5 text-[13px]">
          {summary.results.map((result) => (
            <li key={result.key} className="rounded-md bg-ops-paper px-3 py-2">
              <p className="flex items-center gap-2 font-medium">
                {result.text}
                {result.order && (
                  <span className="text-ops-sub tabular-nums">{result.order.no}</span>
                )}
                {result.reason && (
                  <span className="ml-auto text-[12px] text-ops-wait">{result.reason}</span>
                )}
              </p>
              {result.question && <p className="mt-0.5 text-ops-sub">“{result.question}”</p>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/** 판정 두 칸 — 고객 불만(대상 · 강도 · 고객이 한 말), AI 응대 오류(유형 · 근거) */
function ComplaintSections({ summary }: { summary: Summary }) {
  const count = (title: string, n: number) => (n ? `${title} ${n}` : title)
  return (
    <>
      <Section id="customer-complaints" title={count('고객 불만', summary.customer.length)}>
        {summary.customer.length === 0 ? (
          <Muted>{emptyText(summary, '고객 불만이 없습니다.', true)}</Muted>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {summary.customer.map((complaint, i) => (
              <Judged
                key={i}
                tone="stop"
                head={complaint.level ? `${complaint.label} (${complaint.level})` : complaint.label}
                time={complaint.time}
                go={complaint.go}
              >
                <p className="text-ops-ink/80">“{complaint.quote}”</p>
              </Judged>
            ))}
          </ul>
        )}
      </Section>
      <Section id="ai-errors" title={count('AI 응대 오류', summary.errors.length)}>
        {summary.errors.length === 0 ? (
          <Muted>{emptyText(summary, 'AI 응대 오류가 없습니다.', true)}</Muted>
        ) : (
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {summary.errors.map((error, i) => (
              <Judged key={i} tone="wait" head={error.label} time={error.time} go={error.go}>
                <p className="text-ops-ink/80">{error.reason}</p>
              </Judged>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

/** 이 통화의 주문 한 건 — 출발지 · 도착지 · 물품 · 가액 · 배송비 · 수거 희망 (주문 상세에서) */
function OrderCard({ seq, what }: { seq: number; what: '접수' | '취소' }) {
  const { order: o, failed } = useCallOrder(seq)
  const look = o?.status ? STATUS_LOOK[o.cancelled ? 'CANCELLED' : o.status] : null
  const who = (p: { name: string; phoneNumber: string }) =>
    [p.name, p.phoneNumber && fmtPhone(p.phoneNumber)].filter(Boolean).join('  ')
  const where = (p: { roadAddress: string; detailAddress: string | null }) =>
    [p.roadAddress, p.detailAddress].filter(Boolean).join(' ')
  return (
    <Link
      to={`/orders?o=${seq}&r=all`}
      className="block rounded-md border border-ops-line px-3 py-2.5 text-[13px] hover:border-ops-route"
    >
      <p className="flex items-center gap-2">
        <span className="font-semibold tabular-nums">{orderNo(seq)}</span>
        <span className="text-ops-sub">{what}</span>
        {look && (
          <span className="ml-auto">
            <Badge tone={look.tone}>{look.label}</Badge>
          </span>
        )}
      </p>
      {!o ? (
        <p className="mt-1 text-ops-faint">
          {failed ? '주문을 불러오지 못했습니다.' : '불러오는 중…'}
        </p>
      ) : (
        <dl className="mt-2 grid grid-cols-[56px_1fr] gap-y-1.5">
          <dt className="text-ops-sub">출발지</dt>
          <dd>
            <span className="block font-medium">{who(o.sender)}</span>
            {where(o.sender)}
          </dd>
          <dt className="text-ops-sub">도착지</dt>
          <dd>
            <span className="block font-medium">{who(o.receiver)}</span>
            {where(o.receiver)}
          </dd>
          <dt className="text-ops-sub">물품</dt>
          <dd>{itemsText(o.items) || '없음'}</dd>
          {/* 통화에서 받은 가액이 맞게 들어갔는지 바로 보게 */}
          <dt className="text-ops-sub">가액</dt>
          <dd className="tabular-nums">
            {o.itemPrice === null ? '없음' : priceBand(o.itemPrice).label}
          </dd>
          <dt className="text-ops-sub">배송비</dt>
          <dd className="tabular-nums">{won(o.notifiedPrice) || '없음'}</dd>
          <dt className="text-ops-sub">수거</dt>
          <dd className="tabular-nums">{dateTime(o.pickupRequestedAt) || '없음'}</dd>
        </dl>
      )}
    </Link>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`c-${id}`}>
      <h2 className="mb-2 text-[12px] font-semibold text-ops-sub">{title}</h2>
      {children}
    </section>
  )
}
/** 판정 한 건 — 이름 · 시각(누르면 그 말부터 듣기) · 내용. 빨강 = 고객 불만, 주황 = AI 응대 오류 */
function Judged({
  tone,
  head,
  time,
  go,
  children,
}: {
  tone: 'stop' | 'wait'
  head: string
  time: string
  go: () => void
  children: ReactNode
}) {
  return (
    <li
      className={`rounded-md px-3 py-2 ${tone === 'stop' ? 'bg-ops-stop-soft' : 'bg-ops-wait-soft'}`}
    >
      <p className="flex items-center justify-between gap-2">
        <span className={`font-semibold ${tone === 'stop' ? 'text-ops-stop' : 'text-ops-wait'}`}>
          {head}
        </span>
        {time && (
          <button
            type="button"
            onClick={go}
            title="이 말부터 듣기"
            className="rounded text-[11px] text-ops-faint tabular-nums outline-none hover:text-ops-route focus-visible:ring-2 focus-visible:ring-ops-route"
          >
            {time}
          </button>
        )}
      </p>
      {children}
    </li>
  )
}
const Muted = ({ children }: { children: ReactNode }) => (
  <p className="text-[13px] text-ops-faint">{children}</p>
)
