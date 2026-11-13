// 시나리오 시험 상세 (11/12, Figma 1941:5457) — 통화 상세와 같은 한 화면. 시나리오 시험 화면의 표에서 줄을 눌러 옴
// 위: ‹ 시나리오 이름 · 탭 [이 버전] [통화에 사용 중] [시나리오] · 시험 시각. [시나리오] = 고객 대본 | 정답 · 행동 확인 (보기만)
// 왼쪽 대화(누르면 그 말부터 듣기) | 오른쪽 결과표 | 맨 아래 녹음 재생
import { useRef, type ReactNode } from 'react'
import { Navigate, useLocation, useParams } from 'react-router'
import { Badge, PageHead } from '@/shared/ui'
import { Talk } from '@/shared/call/AiSteps'
import { Player } from '@/shared/call/Player'
import { useFollowScroll } from '@/shared/call/useFollowScroll'
import { SCENARIO_TEST } from '@/features/persona/hooks/useScenarioTest'
import {
  useScenarioCall,
  useScenarioDetail,
  useScenarioScript,
} from '@/features/persona/hooks/useScenarioDetail'
import { Result } from './ScenarioTest'

export function ScenarioDetailPage() {
  const { personaSeq, version, scenario = '' } = useParams()
  if (!SCENARIO_TEST) return <Navigate to="/personas" replace /> // 시나리오 시험이 꺼진 환경
  return (
    <Detail
      key={`${personaSeq}-${version}-${scenario}`}
      personaSeq={Number(personaSeq)}
      version={Number(version)}
      scenario={scenario}
    />
  )
}

function Detail(p: { personaSeq: number; version: number; scenario: string }) {
  const vm = useScenarioDetail(p.personaSeq, p.version, p.scenario)
  // 온 곳(시나리오 시험 화면)으로 — 주소로 바로 왔으면 이 결과의 버전 화면으로
  const from = (useLocation().state as { from?: string } | null)?.from
  const cur = vm.current
  return (
    <>
      <PageHead
        title={vm.title}
        back={{
          to: from ?? `/personas/${p.personaSeq}/tests/${p.version}`,
          label: '시나리오 시험으로',
        }}
      >
        <span className="truncate text-[13px] text-ops-sub">{vm.sub}</span>
      </PageHead>
      {vm.note ? (
        <Note>{vm.note}</Note>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-6 border-b border-ops-line bg-white px-6">
            <div role="tablist" aria-label="버전" className="flex gap-6">
              {vm.tabs.map((t) => (
                <Tab key={t.label} on={t.on} pick={t.pick}>
                  {t.label}
                  <span className="text-[13px] font-normal text-ops-sub">{t.date}</span>
                  <span className="text-[13px] font-normal">
                    <Result cell={t.cell} none="결과 없음" />
                  </span>
                </Tab>
              ))}
              <Tab on={vm.script.on} pick={vm.script.pick}>
                시나리오
              </Tab>
            </div>
            <span className="ml-auto text-[13px] text-ops-sub tabular-nums">{cur?.when}</span>
          </div>
          {!cur ? (
            <Script scenario={p.scenario} />
          ) : cur.runId ? (
            <Call key={cur.runId} runId={cur.runId} scenario={p.scenario} />
          ) : (
            <Note>{cur.empty}</Note>
          )}
        </>
      )}
    </>
  )
}

function Tab({ on, pick, children }: { on: boolean; pick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={pick}
      className={`-mb-px flex items-center gap-2 border-b-2 py-3 text-[15px] font-bold outline-none focus-visible:text-ops-route ${on ? 'border-ops-route text-ops-route' : 'border-transparent text-ops-sub hover:text-ops-ink'}`}
    >
      {children}
    </button>
  )
}

// 통화 화면과 같은 틀: 왼쪽 넓은 칸 | 오른쪽 표 칸
const SIDE =
  'w-[520px] shrink-0 [scrollbar-width:thin] overflow-y-auto border-l border-ops-line bg-white px-6 py-4 max-xl:w-[420px]'
const TABLE_HEAD = 'h-8 border-b border-ops-line [&>th]:text-left! [&>th]:font-medium'
const TABLE_ROW = 'border-b border-ops-line/60 align-top [&>td]:py-2 [&>td]:pr-3'

/** [시나리오] 탭 — 왼쪽 고객 대본(순서대로) | 오른쪽 정답 · 행동 확인 */
function Script({ scenario }: { scenario: string }) {
  const vm = useScenarioScript(scenario)
  if (vm.note) return <Note>{vm.note}</Note>
  return (
    <div className="flex min-h-0 flex-1">
      <section
        aria-label="고객 대본"
        className="min-h-0 min-w-0 flex-1 [scrollbar-width:thin] overflow-y-auto bg-white px-6 py-4"
      >
        <h2 className="text-[15px] font-bold">
          고객 대본
          <span className="ml-2 text-[13px] font-normal text-ops-sub">{vm.caller}</span>
        </h2>
        <ol className="mt-2 text-[14px]">
          {vm.lines.map((l) => (
            <li key={l.no} className="flex items-baseline gap-3 border-b border-ops-line/60 py-2">
              <span className="w-5 shrink-0 text-right text-[12px] text-ops-faint tabular-nums">
                {l.no}
              </span>
              <span>{l.text}</span>
            </li>
          ))}
        </ol>
      </section>
      <section aria-label="정답" className={SIDE}>
        <h2 className="text-[15px] font-bold">정답</h2>
        <table className="mt-2 w-full table-fixed text-[13px]">
          <thead className="text-ops-sub">
            <tr className={TABLE_HEAD}>
              <th scope="col" className="w-[40%]">
                항목
              </th>
              <th scope="col">값</th>
            </tr>
          </thead>
          <tbody className="[&_td]:text-left">
            {vm.expected.map((e) => (
              <tr key={e.name} className={TABLE_ROW}>
                <td>{e.name}</td>
                <td className="break-words tabular-nums">{e.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {vm.checks.length > 0 && (
          <>
            <h2 className="mt-6 text-[15px] font-bold">행동 확인</h2>
            <ul className="mt-2 text-[13px]">
              {vm.checks.map((c) => (
                <li key={c} className="border-b border-ops-line/60 py-2">
                  {c}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}

const Note = ({ children }: { children: string }) => (
  <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
    {children}
  </p>
)

function Call({ runId, scenario }: { runId: string; scenario: string }) {
  const vm = useScenarioCall(runId, scenario)
  const list = useRef<HTMLDivElement>(null)
  const touched = useFollowScroll(list, vm.focusKey, vm.player.playing, vm.jump)
  if (vm.note) return <Note>{vm.note}</Note>
  return (
    <>
      <div className="flex min-h-0 flex-1">
        <div
          ref={list}
          onWheel={touched}
          onTouchMove={touched}
          aria-label="통화 대화"
          className="flex min-h-0 min-w-0 flex-1 [scrollbar-width:thin] flex-col gap-0.5 overflow-y-auto bg-white px-4 py-4"
        >
          {vm.lines.map((l) => (
            <Talk
              key={l.key}
              dataKey={l.key}
              ai={l.ai}
              text={l.text}
              time={l.time}
              on={l.on}
              flag={l.flag}
              onClick={l.listen}
            />
          ))}
        </div>
        <section aria-label="결과표" className={SIDE}>
          <h2 className="text-[15px] font-bold">
            결과표
            <span className="ml-2 text-[13px] font-normal text-ops-sub">{vm.counts}</span>
          </h2>
          <table className="mt-2 w-full table-fixed text-[13px]">
            <thead className="text-left text-ops-sub">
              <tr className="h-8 border-b border-ops-line [&>th]:text-left! [&>th]:font-medium">
                <th scope="col" className="w-[30%]">
                  항목
                </th>
                <th scope="col">정답</th>
                <th scope="col">통화 결과</th>
                <th scope="col" className="w-[76px]">
                  판정
                </th>
              </tr>
            </thead>
            <tbody className="[&_td]:text-left">
              {vm.checks.map((c) => {
                const skip = c.status === 'skip'
                const bad = c.status === 'fail'
                return (
                  <tr
                    key={c.key}
                    className={`border-b border-ops-line/60 align-top [&>td]:py-2 [&>td]:pr-3 ${skip ? 'text-ops-sub' : ''}`}
                  >
                    {c.behaviour ? (
                      <td colSpan={3}>
                        {c.name}
                        {bad && <p className="font-bold text-ops-stop">{c.actual}</p>}
                      </td>
                    ) : (
                      <>
                        <td>{c.name}</td>
                        <td className="break-words tabular-nums">{c.expected}</td>
                        <td
                          className={`break-words whitespace-pre-line tabular-nums ${bad ? 'font-bold text-ops-stop' : ''}`}
                        >
                          {c.actual}
                        </td>
                      </>
                    )}
                    {/* 판정 사유(채점 안 한 이유 등)는 글로 붙이지 않고 칩에 올리면 보임 (11/12 사용자: 설명 문구 없이) */}
                    <td className="pr-0!" title={c.note || undefined}>
                      <Badge tone={bad ? 'stop' : skip ? 'idle' : 'done'}>
                        {bad ? '실패' : skip ? '채점 안 함' : '통과'}
                      </Badge>
                      {/* 어느 말에서 실패했는지 — 누르면 대화의 그 말로 가서 거기부터 들음 */}
                      {c.spot && (
                        <button
                          type="button"
                          onClick={c.spot.go}
                          className="mt-1 block text-[12px] font-semibold text-ops-route tabular-nums outline-none hover:underline focus-visible:underline"
                        >
                          {c.spot.time}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      </div>
      <Player player={vm.player} audioRef={vm.audioRef} />
    </>
  )
}
