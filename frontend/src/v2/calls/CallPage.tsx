// v2 통화 상세 (11/06 기업 피드백 반영)
// 위 띠: 고객 · 상태 · 시작 · 통화 시간 · AI 상담가 · 고객 용건
// 왼쪽 대화: 한 줄 기록 (이름 · 말 · 시각). AI 동작(주소 검색 · 저장 · 접수 전송 등)은 그 말 아래 들여 쓴 줄로
// 오른쪽: 운영팀용 정보 — 고객, 이 통화의 주문(출발지 · 도착지 · 물품), 처리 결과, 불만
// FAQ 사례 · 미답변에서 오면 그 말로 스크롤해 표시 (location.state: at = 그 말의 시각 ISO, unanswered = 미답변 번호)
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Link, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { orderQueries } from '@/shared/order/orderApi'
import { pickParcel } from '@/shared/order/useOrderDetail'
import { orderNo, priceBand } from '@/shared/order/labels'
import { fmtPhone } from '@/shared/lib/format'
import { useFollowScroll } from '@/features/call/hooks/useFollowScroll'
import { PageHead } from '@/v2/V2Layout'
import { Badge, Kinds } from '@/v2/ui'
import { itemsText, STATUS_LOOK, won } from '@/v2/orders/orderLook'
import { dateTime } from '@/v2/lib/when'
import { useCallView, type CallView } from './useCallView'
import { Player } from './Player'
import { AiSteps, AiToggle, Talk } from './AiSteps'
import { useShowAi } from '@/v2/lib/useShowAi'

type Line = CallView['segments'][number]['lines'][number]
type Event = CallView['events'][number]
type Arrival = { at?: string; unanswered?: number; from?: string } | null

/** 뒤로 가면 들어온 화면으로 — 미답변 · 주문에서 왔으면 그 화면 이름 */
const backLabel = (from: string) =>
  from.startsWith('/unanswered')
    ? '미답변 문의로'
    : from.startsWith('/orders')
      ? '주문으로'
      : '통화 목록으로'

export function CallPage() {
  const { callId } = useParams()
  return <CallBody key={callId} callId={Number(callId)} />
}

function CallBody({ callId }: { callId: number }) {
  const vm = useCallView(callId)
  const [showAi, setShowAi] = useShowAi()
  const arrival = useLocation().state as Arrival
  const from = arrival?.from ?? '/calls'
  const s = vm.summary

  return (
    <>
      <PageHead title={`통화 #${callId}`} back={{ to: from, label: backLabel(from) }}></PageHead>
      {vm.error ? (
        <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
          {vm.error}
        </p>
      ) : (
        <>
          {s && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-ops-line bg-white px-6 py-3">
              <span className="flex items-baseline gap-2">
                <span className="text-[17px] font-bold">{s.name || '이름 모름'}</span>
                <span className="text-[14px] text-ops-sub tabular-nums">{s.phone}</span>
              </span>
              <Badge tone={s.state.tone}>{s.state.label}</Badge>
              <Fact label="시작">{s.startedAt}</Fact>
              <Fact label="통화 시간">{s.duration}</Fact>
              <Fact label="AI 상담가">{s.persona}</Fact>
              {s.analyzed && (
                <span className="flex gap-1">
                  <Kinds kinds={s.kinds} />
                </span>
              )}
              <span className="ml-auto">
                <AiToggle on={showAi} onChange={setShowAi} />
              </span>
            </div>
          )}
          {vm.notice && (
            <p
              role="status"
              className="shrink-0 bg-ops-wait-soft px-6 py-1.5 text-[12px] text-ops-wait"
            >
              {vm.notice}
            </p>
          )}
          <div className="flex min-h-0 flex-1">
            <Chat vm={vm} arrival={arrival} showAi={showAi} />
            <Contents vm={vm} />
          </div>
          <Player player={vm.player} audioRef={vm.audioRef} />
        </>
      )}
    </>
  )
}

function Fact({ label, children }: { label: string; children: string }) {
  if (!children) return null
  return (
    <span className="text-[13px]">
      <span className="text-ops-sub">{label} </span>
      <span className="font-medium tabular-nums">{children}</span>
    </span>
  )
}

/** 대화 — 말풍선 사이에 그 시각의 AI 처리 기록. 재생 중이면 지금 말을 따라 내려감 */
function Chat({ vm, arrival, showAi }: { vm: CallView; arrival: Arrival; showAi: boolean }) {
  const list = useRef<HTMLDivElement>(null)
  const touched = useFollowScroll(list, vm.focusKey, vm.player.playing, vm.jump)
  const lines = vm.segments.flatMap((g) => g.lines)
  const marked = useArrival(list, lines, vm, arrival)

  // AI 처리 기록 → 그 시각 직전에 시작한 말 아래에 붙임 (시각을 모르면 맨 끝)
  const after = new Map<number | 'end', Event[]>()
  for (const e of vm.events) {
    const at = e.atSec
    const host = at === null ? undefined : lines.findLast((l) => l.atSec !== null && l.atSec <= at)
    const k = host ? host.key : at === null ? 'end' : (lines[0]?.key ?? 'end')
    after.set(k, [...(after.get(k) ?? []), e])
  }
  const steps = (k: number | 'end') => (showAi ? (after.get(k) ?? []) : [])
  const row = (l: Line) => (
    <div key={l.key}>
      <Talk
        ai={l.who === 'AI'}
        text={l.text}
        time={l.time}
        on={l.key === vm.focusKey}
        marked={l.key === marked}
        onClick={l.onClick}
        dataKey={l.key}
      />
      <AiSteps steps={steps(l.key)} />
    </div>
  )

  return (
    <div
      ref={list}
      onWheel={touched}
      onTouchMove={touched}
      // 스크롤 막대 끌기(목록 자체를 누름) · 키보드 스크롤도 사람이 움직인 것
      onPointerDown={(e) => e.target === e.currentTarget && touched()}
      onKeyDown={(e) =>
        ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key) &&
        touched()
      }
      aria-label="통화 대화"
      className="relative flex min-h-0 min-w-0 flex-1 [scrollbar-width:thin] flex-col gap-0.5 overflow-y-auto bg-white px-4 py-4"
    >
      {lines.length === 0 && (
        <p className="py-10 text-center text-[14px] text-ops-sub">
          {vm.isLoading ? '불러오는 중…' : vm.scriptEmpty}
        </p>
      )}
      {vm.segments.map((seg, i) =>
        seg.complaint ? (
          // 불만 구간 — 왼쪽 빨간 줄 + 이름 (상자로 감싸지 않음)
          <div key={i} className="my-1 flex flex-col gap-0.5 border-l-2 border-ops-stop">
            <p className="px-3 pt-1 text-[12px] font-semibold text-ops-stop">
              불만: {seg.complaint.label}
            </p>
            {seg.lines.map(row)}
          </div>
        ) : (
          seg.lines.map(row)
        ),
      )}
      <AiSteps steps={steps('end')} />
    </div>
  )
}

/** FAQ 사례 · 미답변에서 왔으면 그 말을 찾아 가운데로 스크롤하고 잠깐 표시 */
function useArrival(
  list: RefObject<HTMLDivElement | null>,
  lines: Line[],
  vm: CallView,
  arrival: Arrival,
) {
  let sec: number | null = null
  if (arrival?.unanswered != null)
    sec = vm.summary?.results.find((r) => r.unansweredSeq === arrival.unanswered)?.atSec ?? null
  else if (arrival?.at && vm.startedIso)
    sec = (Date.parse(arrival.at) - Date.parse(vm.startedIso)) / 1000
  // 그 시각 직전에 시작한 고객 말 (질문은 고객이 함), 없으면 아무 말
  const near = (who?: string) =>
    sec === null
      ? undefined
      : lines.findLast((l) => (!who || l.who === who) && l.atSec !== null && l.atSec <= sec + 2)
  const key = (near('고객') ?? near())?.key ?? null
  const [shown, setShown] = useState<number | null>(null)
  useEffect(() => {
    if (key === null) return
    const box = list.current
    const el = box?.querySelector<HTMLElement>(`[data-key="${key}"]`)
    if (box && el) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2 })
    const on = setTimeout(() => setShown(key), 0)
    const off = setTimeout(() => setShown(null), 2400)
    return () => {
      clearTimeout(on)
      clearTimeout(off)
    }
  }, [key, list])
  return shown
}

/** 오른쪽 운영팀용 정보 — 고객 · 주문 · 처리 결과 · 불만 (한 화면에 다 보여 목차는 두지 않음) */
function Contents({ vm }: { vm: CallView }) {
  const s = vm.summary
  // 분석 실패면 기다리라는 말 대신 받지 못했다고
  const waitText =
    s?.state.label === '분석 실패' ? '분석을 받지 못했습니다.' : '분석이 끝나면 보입니다.'
  return (
    <aside
      aria-label="통화 정보"
      className="flex w-[400px] shrink-0 flex-col border-l border-ops-line bg-white max-xl:w-[340px]"
    >
      <div className="relative min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-5 py-4">
        {!s ? (
          <p className="text-[13px] text-ops-sub">불러오는 중…</p>
        ) : (
          <div className="flex flex-col gap-6">
            <Section id="customer" title="고객">
              <dl className="grid grid-cols-[72px_1fr] gap-y-1.5 text-[13px]">
                <dt className="text-ops-sub">이름</dt>
                <dd className="font-medium">{s.name || '모름'}</dd>
                <dt className="text-ops-sub">전화번호</dt>
                <dd className="tabular-nums">{s.phone}</dd>
                <dt className="text-ops-sub">소속</dt>
                <dd>{s.member || '모름'}</dd>
                <dt className="text-ops-sub">구분</dt>
                <dd>{s.isNew === null ? '모름' : s.isNew ? '신규 고객' : '기존 고객'}</dd>
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
            <Section id="complaints" title="불만">
              {s.complaints.length === 0 ? (
                <Muted>{s.analyzed ? '불만이 없습니다.' : waitText}</Muted>
              ) : (
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {s.complaints.map((c, i) => (
                    <li key={i} className="rounded-md bg-ops-stop-soft px-3 py-2">
                      <p className="font-semibold text-ops-stop">{c.label}</p>
                      <p className="text-ops-ink/80">{c.reason}</p>
                    </li>
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
  const q = useQuery({ ...orderQueries.detail(seq), staleTime: 30_000 })
  const o = q.data ? pickParcel(q.data) : null
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
          {q.error ? '주문을 불러오지 못했습니다.' : '불러오는 중…'}
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
          {/* 통화에서 받은 가액이 맞게 들어갔는지 바로 보게 (11/09 사용자) */}
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
const Muted = ({ children }: { children: ReactNode }) => (
  <p className="text-[13px] text-ops-faint">{children}</p>
)
