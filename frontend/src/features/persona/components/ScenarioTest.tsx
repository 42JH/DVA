// 시나리오 시험 (11/12, Figma 1990:7976) — AI 상담가 가운데 카드의 [시나리오 시험]을 눌러 오는 한 화면. 가짜 모드에서만
// (처음엔 가운데 카드의 탭이었음 → 11/12 사용자: 탭 대신 버튼 + 더 크게. 주소 /personas/:personaSeq/tests/:version)
// 위 줄: ‹ 시나리오 시험 + 상담가 이름 · 버전 저장 시각. 카드 위: 상태(시험 전 · 시험 중 진행 · 끝난 뒤 요약) + [전체 시험]
// 표: 업무 · 시나리오 · 통화에 사용 중 · 이 버전 · 변화. 줄을 누르면 그 통화의 상세(대화 · 결과표 · 녹음)
// 시험 뒤 글을 고쳤으면 고치기 전 결과를 흐리게 + 안내 한 줄
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { Badge, Btn, PageHead } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'
import type { Cell } from '@/features/persona/hooks/scenarioTest'
import {
  SCENARIO_TEST,
  useScenarioTest,
  useScenarioTestPage,
} from '@/features/persona/hooks/useScenarioTest'

export function ScenarioTestPage() {
  const { personaSeq, version } = useParams()
  if (!SCENARIO_TEST) return <Navigate to="/personas" replace /> // 가짜 모드에서만 있는 화면
  return (
    <Page
      key={`${personaSeq}-${version}`}
      personaSeq={Number(personaSeq)}
      version={Number(version)}
    />
  )
}

function Page(p: { personaSeq: number; version: number }) {
  const vm = useScenarioTestPage(p.personaSeq, p.version)
  return (
    <>
      <PageHead title="시나리오 시험" back={vm.back}>
        <span className="truncate text-[13px] text-ops-sub">{vm.sub}</span>
      </PageHead>
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ops-line bg-white">
          {vm.me ? <ScenarioTest me={vm.me} dateOf={vm.dateOf} /> : <Note>{vm.note}</Note>}
        </article>
      </div>
    </>
  )
}

const Note = ({ children }: { children: string | null }) => (
  <p className="flex flex-1 items-center justify-center text-[14px] text-ops-sub">{children}</p>
)

function ScenarioTest({
  me,
  dateOf,
}: {
  me: { personaSeq: number; version: number; isHead: boolean }
  dateOf: (version: number) => string
}) {
  const vm = useScenarioTest(me, dateOf)
  const navigate = useNavigate()
  if (vm.note) return <Note>{vm.note}</Note>
  const dim = vm.state === 'stale' ? 'opacity-50' : ''
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {vm.confirm && (
        <Confirm
          title={vm.confirm.title}
          ok="시험 시작"
          busy={vm.confirm.busy}
          error={vm.confirm.error}
          onOk={vm.confirm.ok}
          onClose={vm.confirm.close}
        />
      )}
      {vm.state === 'stale' && (
        <p role="status" className="shrink-0 bg-ops-wait-soft px-6 py-2 text-[13px] text-ops-wait">
          시험 뒤에 프롬프트를 고쳤습니다. 아래는 고치기 전 글의 결과입니다.
        </p>
      )}
      <div className="flex min-h-24 shrink-0 flex-wrap items-center gap-x-14 gap-y-2 px-6 py-5">
        {vm.state === 'none' && (
          <p className="text-[16px] font-bold">이 버전은 아직 시험하지 않았습니다</p>
        )}
        {vm.progress && (
          <div className="flex flex-col gap-2">
            <p className="text-[16px] font-bold">
              {vm.progress.text}
              <span className="ml-2 text-[13px] font-normal text-ops-sub">
                {vm.progress.started}
              </span>
            </p>
            <progress
              value={vm.progress.value}
              max={vm.progress.max}
              className="h-2 w-[480px] appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-ops-line [&::-webkit-progress-value]:bg-ops-route"
            />
          </div>
        )}
        {vm.summary?.map((s) => (
          <dl key={s.label} className={dim}>
            <dt className="text-[13px] text-ops-sub">{s.label}</dt>
            <dd className={`text-[28px] leading-9 font-bold tabular-nums ${s.tone}`}>{s.value}</dd>
          </dl>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ops-sub">{vm.finished}</span>
          {vm.canRun && (
            <>
              {vm.retryLabel && (
                <Btn kind="plain" onClick={vm.retry}>
                  {vm.retryLabel}
                </Btn>
              )}
              <Btn kind="line" onClick={vm.runAll}>
                {vm.allLabel}
              </Btn>
            </>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto">
        <table className={`w-full table-fixed text-[14px] ${dim}`}>
          <thead className="sticky top-0 bg-ops-paper text-left text-ops-sub">
            <tr className="h-10 [&>th]:text-left! [&>th]:font-medium">
              <th scope="col" className="w-40 pl-6">
                업무
              </th>
              <th scope="col">시나리오</th>
              <th scope="col" className="w-55">
                통화에 사용 중 <Date_>{vm.baseDate}</Date_>
              </th>
              <th scope="col" className="w-55">
                이 버전 <Date_>{vm.nowDate}</Date_>
              </th>
              <th scope="col" className="w-40">
                변화
              </th>
            </tr>
          </thead>
          <tbody className="[&_td]:text-left">
            {vm.rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => void navigate(r.to, { state: vm.from })}
                className={`h-11 border-t ${r.firstOfGroup ? 'border-ops-line' : 'border-ops-line/50'} cursor-pointer hover:bg-ops-paper`}
              >
                <td className="pl-6 text-ops-sub">{r.firstOfGroup && r.group}</td>
                <td className="truncate pr-3">
                  {/* 줄 전체가 눌리지만 키보드로는 이 링크로 (줄의 onClick과 겹쳐 두 번 이동하지 않게 막음) */}
                  <Link
                    to={r.to}
                    state={vm.from}
                    onClick={(e) => e.stopPropagation()}
                    className="outline-none focus-visible:underline"
                  >
                    {r.name}
                  </Link>
                </td>
                <td>
                  <Result cell={r.base} none="결과 없음" />
                </td>
                <td>
                  <Result cell={r.now} none="-" />
                </td>
                <td
                  className={
                    r.change === '새로 실패'
                      ? 'font-bold text-ops-stop'
                      : r.change === '새로 통과'
                        ? 'font-bold text-ops-done'
                        : 'text-ops-faint'
                  }
                >
                  {r.change}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const Date_ = ({ children }: { children: string }) => (
  <span className="ml-1 font-normal text-ops-faint">{children}</span>
)

/** 표의 한 칸 — 연결 실패는 시나리오 실패가 아니라 회색 */
export function Result({ cell, none }: { cell: Cell; none: string }) {
  if (cell === 'pass') return <Badge tone="done">통과</Badge>
  if (cell === 'fail') return <Badge tone="stop">실패</Badge>
  if (cell === 'error') return <Badge tone="idle">연결 실패</Badge>
  if (cell === 'running') return <span className="font-semibold text-ops-route">시험 중</span>
  return <span className="text-ops-sub">{cell === 'queued' ? '대기' : none}</span>
}
