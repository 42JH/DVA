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

/** 오른쪽 운영팀용 정보 — 고객 · 주문 · 처리 결과 · 불만 (한 화면에 다 보여 목차는 두지 않음) */
export function Contents({ vm }: { vm: CallView }) {
  const s = vm.summary
  const side = useRef<HTMLDivElement>(null)
  useKeepScroll(side, 'side')
  // 분석 실패면 기다리라는 말 대신 받지 못했다고
  const waitText =
    s?.state.label === '분석 실패' ? '분석을 받지 못했습니다.' : '분석이 끝나면 보입니다.'
  return (
    <aside
      aria-label="통화 정보"
      className="flex w-[400px] shrink-0 flex-col border-l border-ops-line bg-white max-xl:w-[340px]"
    >
      <div
        ref={side}
        className="relative min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-5 py-4"
      >
        {!s ? (
          <p className="text-[13px] text-ops-sub">불러오는 중…</p>
        ) : (
          <div className="flex flex-col gap-6">
            <Section id="customer" title={s.name ? '고객' : '발신자'}>
              <dl className="grid grid-cols-[72px_1fr] gap-y-1.5 text-[13px]">
                {s.name ? (
                  <>
                    <dt className="text-ops-sub">이름</dt>
                    <dd className="font-medium">{s.name}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-ops-sub">고객 정보</dt>
                    <dd className="text-ops-sub">등록되지 않은 번호</dd>
                  </>
                )}
                <dt className="text-ops-sub">전화번호</dt>
                <dd className="tabular-nums">{s.phone}</dd>
                {/* 모르는 값은 '모름' 대신 줄을 뺌 — 미등록 발신자는 소속이 없고, 신규 여부는 분석 뒤에 옴 */}
                {s.member && (
                  <>
                    <dt className="text-ops-sub">소속</dt>
                    <dd>{s.member}</dd>
                  </>
                )}
                {s.isNew !== null && (
                  <>
                    <dt className="text-ops-sub">구분</dt>
                    <dd>{s.isNew ? '신규 고객' : '기존 고객'}</dd>
                  </>
                )}
                {s.asks.length > 0 && (
                  <>
                    <dt className="text-ops-sub">요청</dt>
                    <dd className="text-ops-wait">{s.asks.join(', ')}</dd>
                  </>
                )}
              </dl>
            </Section>
            <Section id="orders" title="주문">
              {s.orders.length === 0 ? (
                <Muted>
                  {s.analyzed ? '이 통화에서 접수하거나 취소한 주문이 없습니다.' : waitText}
                </Muted>
              ) : (
                <div className="flex flex-col gap-2">
                  {s.orders.map((o) => (
                    <OrderCard key={o.seq} seq={o.seq} what={o.what} />
                  ))}
                </div>
              )}
            </Section>
            <Section id="results" title="처리 결과">
              {s.results.length === 0 ? (
                <Muted>{s.analyzed ? '처리한 일이 없습니다.' : waitText}</Muted>
              ) : (
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {s.results.map((r) => (
                    <li key={r.key} className="rounded-md bg-ops-paper px-3 py-2">
                      <p className="flex items-center gap-2 font-medium">
                        {r.text}
                        {r.order && <span className="text-ops-sub tabular-nums">{r.order.no}</span>}
                        {r.reason && (
                          <span className="ml-auto text-[12px] text-ops-wait">{r.reason}</span>
                        )}
                      </p>
                      {r.question && <p className="mt-0.5 text-ops-sub">“{r.question}”</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            {/* 판정: 고객 불만 = 대상 · 강도 · 고객이 한 말, AI 응대 오류 = 유형 · 근거. 판정 전('아직 분석 전') · 없음 · 통화 분석 전을 문구로 나눔 */}
            <Section
              id="customer-complaints"
              title={s.customer.length ? `고객 불만 ${s.customer.length}` : '고객 불만'}
            >
              {s.customer.length === 0 ? (
                <Muted>
                  {!s.analyzed
                    ? waitText
                    : s.judging
                      ? '아직 분석 전입니다.'
                      : '고객 불만이 없습니다.'}
                </Muted>
              ) : (
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {s.customer.map((c, i) => (
                    <Judged
                      key={i}
                      tone="stop"
                      head={c.level ? `${c.label} (${c.level})` : c.label}
                      time={c.time}
                      go={c.go}
                    >
                      <p className="text-ops-ink/80">“{c.quote}”</p>
                    </Judged>
                  ))}
                </ul>
              )}
            </Section>
            <Section
              id="ai-errors"
              title={s.errors.length ? `AI 응대 오류 ${s.errors.length}` : 'AI 응대 오류'}
            >
              {s.errors.length === 0 ? (
                <Muted>
                  {!s.analyzed
                    ? waitText
                    : s.judging
                      ? '아직 분석 전입니다.'
                      : 'AI 응대 오류가 없습니다.'}
                </Muted>
              ) : (
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {s.errors.map((c, i) => (
                    <Judged key={i} tone="wait" head={c.label} time={c.time} go={c.go}>
                      <p className="text-ops-ink/80">{c.reason}</p>
                    </Judged>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </div>
    </aside>
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
