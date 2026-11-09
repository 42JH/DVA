import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import type {
  CardState,
  ComplaintView,
  DropOffView,
  RegistrationView,
  WaitView,
} from '@/features/dashboard/hooks/useDashboard'
import { BarChart, Donut } from './Charts'

// 02 대시보드 카드 네 장 (Figma 'AI 상담 성능' 11/04~05 — 카드 모서리 12 · 선 1 · 안쪽 18/20/16) · 숫자 · 열은 연동 명세 기준
// 제목 15/700 + 오른쪽 회색 칩(또는 '그래프 보기') · 대표 수치(30/700 + 단위) + 오른쪽 설명 · 내용 · 맨 아래 집계 기준(10)
// 카드 높이 = 화면에 남는 높이의 반 → 표 줄은 16~25 사이로 줄고 늘며, 그래도 모자라면(1280×650 등) 표 안에서 스크롤
// 카드마다 따로 받음: 처음엔 '불러오는 중…', 실패면 0으로 바꾸지 않고 '다시 시도'(명세 §6)
// 파랑은 brand 하나 (디자인 안에 #1687ed · #2ea3ff가 섞여 있어 새 화면 쪽 brand로 맞춤)

function Card<V>({
  title,
  aside,
  c,
  children,
}: {
  title: string
  aside: ReactNode // 오른쪽 위 — 회색 칩 또는 '그래프 보기'
  c: CardState<V>
  children: (v: V) => ReactNode
}) {
  return (
    <section className="flex min-h-0 min-w-0 flex-col gap-v8 rounded-xl border border-line px-5 py-v16">
      <header className="flex h-7 shrink-0 items-center gap-2">
        <h2 className="text-[15px] font-bold">{title}</h2>
        {aside}
      </header>
      {c.view ? (
        <div
          className={`flex min-h-0 flex-1 flex-col gap-v8 transition-opacity ${c.stale ? 'opacity-50' : ''}`}
        >
          {children(c.view)}
        </div>
      ) : (
        <p className="m-auto text-[12px] text-muted">
          {c.failed ? (
            <>
              불러오지 못했습니다.{' '}
              <button
                type="button"
                onClick={c.retry}
                className="font-semibold text-brand hover:underline"
              >
                다시 시도
              </button>
            </>
          ) : (
            '불러오는 중…'
          )}
        </p>
      )}
    </section>
  )
}

/** 대표 수치 줄 — 큰 숫자 + 단위(값이 없으면 '—'만) · 오른쪽 설명. blue = 불편 표현 카드(숫자 · 단위 파랑) */
function Headline({
  value,
  unit,
  blue = false,
  children,
}: {
  value: string
  unit: string
  blue?: boolean
  children: ReactNode
}) {
  return (
    <div className="flex shrink-0 items-center gap-[5px]">
      <span
        className={`text-v30 font-bold tabular-nums ${blue ? 'tracking-[-1px] text-brand' : ''}`}
      >
        {value}
      </span>
      {value !== '—' && (
        <span className={blue ? 'text-[16px] text-brand' : 'text-[13px] font-medium text-muted'}>
          {unit}
        </span>
      )}
      <div className="ml-auto text-right text-[11px] text-muted">{children}</div>
    </div>
  )
}

/** 표 (Figma '단계별 이탈 · Row' · '업무별 응답 대기 · Row') — 머리 줄 옅은 바탕 · 줄 아래 선 · 숫자 열 오른쪽 맞춤
 *  마지막 열 = 굵은 파랑, hot 줄 = 주황 바탕 + 주황 글자 */
function MetricTable({
  cols,
  head,
  rows,
}: {
  cols: string // grid-cols-[…] (글자 그대로)
  head: string[]
  rows: { key: string; cells: string[]; hot: boolean }[]
}) {
  const grid = `grid ${cols} items-center [&>*]:truncate [&>*]:px-2 [&>*+*]:text-right`
  return (
    <div className="flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-y-auto">
      <div
        className={`${grid} max-h-7 min-h-5 flex-[1.12_1_0px] bg-bg text-[11px] font-medium text-muted`}
      >
        {head.map((h) => (
          <span key={h}>{h}</span>
        ))}
      </div>
      {rows.map((r) => (
        <div
          key={r.key}
          className={`${grid} max-h-[25px] min-h-4 flex-[1_1_0px] border-b border-line text-[12px] tabular-nums ${r.hot ? 'bg-attention-soft' : ''}`}
        >
          {r.cells.map((c, i) => (
            <span
              key={i}
              className={
                i === r.cells.length - 1
                  ? `font-bold ${r.hot ? 'text-attention' : 'text-brand'}`
                  : ''
              }
            >
              {c}
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

const Foot = ({ children }: { children: ReactNode }) => (
  <p className="shrink-0 text-[10px] text-muted">{children}</p>
)

const Chip = ({ children }: { children: ReactNode }) => (
  <span className="ml-auto grid h-6 place-items-center rounded-md bg-bg px-2 text-[11px] font-medium text-muted">
    {children}
  </span>
)

/** '그래프 보기' (Figma 118×28 · 파랑 · 모서리 4 · bar-chart-07 아이콘 20 + 13/700) — 신규 · 기존 비교 화면으로 */
function GraphLink({ to }: { to: string }) {
  // v2 통계에서 열면 v2 그래프 화면으로 (위 줄 · 사이드바가 v2 그대로)
  const v2 = useLocation().pathname.startsWith('/v2')
  return (
    <Link
      to={v2 ? to.replace('/dashboard/', '/v2/stats/') : to}
      className="ml-auto flex h-7 shrink-0 items-center gap-2 rounded bg-brand px-3 text-[13px] font-bold text-white hover:opacity-90"
    >
      <svg
        viewBox="0 0 20 20"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M17.5 17.5H5.16667C4.23325 17.5 3.76654 17.5 3.41002 17.3183C3.09641 17.1586 2.84144 16.9036 2.68166 16.59C2.5 16.2335 2.5 15.7668 2.5 14.8333V2.5M5.83333 8.75V14.5833M9.58333 4.58333V14.5833M13.3333 8.75V14.5833M17.0833 4.58333V14.5833" />
      </svg>
      그래프 보기
    </Link>
  )
}

/** §2 단계별 고객 이탈 — 진입 수 열 없음, 비율 = 판정 완료 통화 대비 */
export function DropOffCard({ c }: { c: CardState<DropOffView> }) {
  return (
    <Card title="단계별 이탈률" aside={<GraphLink to="/dashboard/stage-dropoffs" />} c={c}>
      {(v) => (
        <>
          <Headline value={v.value} unit="%">
            {v.note}
          </Headline>
          <MetricTable
            cols="grid-cols-[431.5fr_114fr_136fr]"
            head={['상담 단계', '이탈 통화', '이탈률']}
            rows={v.rows}
          />
          <Foot>이탈률 = 그 단계에서 이탈한 통화 ÷ 판정 완료 통화 · 고객 중도 종료만 집계</Foot>
        </>
      )}
    </Card>
  )
}

/** §3 접수 1건당 소요 시간 — 막대 = 현재 운영 버전 · 직전 버전 */
export function RegistrationCard({ c }: { c: CardState<RegistrationView> }) {
  return (
    <Card title="접수 1건당 소요 시간" aside={<Chip>전체 통화시간 기준</Chip>} c={c}>
      {(v) => (
        <>
          <Headline value={v.value} unit="초/건">
            {v.note}
          </Headline>
          {v.bars.length ? (
            <BarChart bars={v.bars} />
          ) : (
            <p className="m-auto text-[12px] text-muted">운영 중인 상담가 버전이 없습니다.</p>
          )}
          {v.callout && (
            <p className="flex h-[26px] shrink-0 items-center rounded-md bg-frame pl-3 text-[11px] font-medium text-brand">
              {v.callout}
            </p>
          )}
          <Foot>{v.foot}</Foot>
        </>
      )}
    </Card>
  )
}

/** 불편 유형 범례 줄 칸: 이름 | 통화 수 58 | 구성비 65
 *  좁은 창(1280 미만)에선 통화 수 칸을 빼고 이름을 넓힘 — 이름이 '정보 …'로 잘려 무슨 유형인지 몰라서 (11/05 반응형. 수는 표 위 '불편 139'와 구성비로) */
const LEGEND =
  'grid grid-cols-[minmax(0,1fr)_65px] xl:grid-cols-[minmax(0,1fr)_58px_65px] items-center gap-2 px-[9px]'
const COUNT = 'hidden text-right xl:block'

/** §4 고객 불편 표현 통화율 — 메인은 늘 전체 고객 */
export function ComplaintCard({ c }: { c: CardState<ComplaintView> }) {
  return (
    <Card title="고객 불편 표현 통화율" aside={<Chip>전체 고객</Chip>} c={c}>
      {(v) => (
        <>
          <Headline value={v.value} unit="%" blue>
            <p className="font-medium text-ink">{v.ratio}</p>
            <p>{v.excluded}</p>
          </Headline>
          <div className="grid min-h-0 flex-1 grid-cols-[clamp(140px,36%,244px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-4 pt-1">
            <div className="grid min-h-0 place-items-center">
              <Donut slices={v.slices} total={v.total} />
            </div>
            <div className="flex min-h-0 [scrollbar-width:thin] flex-col justify-center overflow-y-auto">
              <div className={`${LEGEND} shrink-0 pb-1.5 text-[10px] text-muted`}>
                <span>불편 유형</span>
                <span className={COUNT}>통화 수</span>
                <span className="text-right">구성비</span>
              </div>
              {v.slices.map((s) => (
                <div
                  key={s.key}
                  className={`${LEGEND} max-h-[27px] min-h-4 flex-[1_1_0px] rounded-[5px] text-[11px] tabular-nums ${s.hot ? 'bg-frame' : ''}`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <i className={`size-2 shrink-0 rounded-[3px] ${s.bg}`} />
                    <span className="truncate">{s.label}</span>
                  </span>
                  <span className={COUNT}>{s.count}</span>
                  <span className="text-right text-sub">{s.share}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="shrink-0 border-t border-line pt-[9px] text-[10px]">
            <p className="font-medium text-sub">{v.foot[0]}</p>
            <p className="text-muted">{v.foot[1]}</p>
          </div>
        </>
      )}
    </Card>
  )
}

/** §5 응답 대기에 쓰인 통화시간 — P95 열 없음, 평균 대기만 */
export function WaitCard({ c }: { c: CardState<WaitView> }) {
  return (
    <Card
      title="응답 대기에 쓰인 통화시간"
      aside={<GraphLink to="/dashboard/response-wait" />}
      c={c}
    >
      {(v) => (
        <>
          <Headline value={v.value} unit="%">
            {v.note}
          </Headline>
          <MetricTable
            cols="grid-cols-[389.5fr_156fr_136fr]"
            head={['처리 유형', '측정 횟수', '평균 대기']}
            rows={v.rows}
          />
          <Foot>
            고객 발화 종료 → 업무 응답 시작 · 겹친 구간 제외
            <br />
            {v.foot}
          </Foot>
        </>
      )}
    </Card>
  )
}
