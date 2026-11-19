// 시나리오 시험 (Figma 1990:7976) — AI 상담가 가운데 카드의 [시나리오 시험]을 눌러 오는 한 화면
// (처음엔 가운데 카드의 탭이었음 → 11/12 사용자: 탭 대신 버튼 + 더 크게. 주소 /personas/:personaSeq/tests/:version)
// 위 줄: ‹ 시나리오 시험 + 상담가 이름 · 고친 내용 · 저장 시각. 표 위(카드 밖): 상태(시험 전 · 시험 중 진행 · 끝난 뒤 숫자) + [전체 시험]
// 표 (새 안 3번, 피그마 2368:5349): 업무 · 시나리오 · 통화에 쓰는 내용 · 고친 내용 · 변화. 줄을 누르면 그 통화의 상세(대화 · 결과표 · 녹음)
// 시험 뒤 글을 고쳤으면 고치기 전 결과를 흐리게 + 안내 한 줄
import { useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router'
import { Badge, Btn, PageHead } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'
import type { Cell } from '@/features/persona/hooks/scenarioTest'
import {
  SCENARIO_TEST,
  useScenarioTest,
  useScenarioTestPage,
  type TestTarget,
} from '@/features/persona/hooks/useScenarioTest'

export function ScenarioTestPage() {
  const { personaSeq, version } = useParams()
  if (!SCENARIO_TEST) return <Navigate to="/personas" replace /> // 시나리오 시험이 꺼진 환경
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
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 pt-4 pb-6">
        {vm.me ? (
          <ScenarioTest me={vm.me} dateOf={vm.dateOf} label={vm.label} />
        ) : (
          <Box>
            <Note>{vm.note}</Note>
          </Box>
        )}
      </div>
    </>
  )
}

// 표 상자 — 다른 목록 화면처럼 회색 바탕 위 흰 상자, 숫자 · 버튼은 상자 밖 위
const Box = ({ children }: { children: ReactNode }) => (
  <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ops-line bg-white">
    {children}
  </article>
)

const Note = ({ children }: { children: string | null }) => (
  <p className="flex flex-1 items-center justify-center text-[14px] text-ops-sub">{children}</p>
)

function ScenarioTest({
  me,
  dateOf,
  label,
}: {
  me: TestTarget
  dateOf: (version: number) => string
  label: string // 이 버전 칸 머리 — '고친 내용' · '통화에 쓰는 내용' · 상담가 이름
}) {
  const vm = useScenarioTest(me, dateOf)
  const navigate = useNavigate()
  const [stopping, setStopping] = useState(false) // [시험 중단] 확인 창 (새 안 2번)
  // 시험이 멈추거나 끝나면 닫힌 것으로 되돌림 — 그대로 두면 다음 시험을 시작하는 순간 이 창이 저절로 다시 뜸(Enter 한 번에 방금 건 시험이 멈춤)
  if (stopping && !vm.stop) setStopping(false)
  if (vm.note)
    return (
      <Box>
        <Note>{vm.note}</Note>
      </Box>
    )
  const dim = vm.state === 'stale' ? 'opacity-50' : ''
  // 통화에 쓰는 버전 자체를 볼 땐 비교할 것이 없음 → 같은 칸 두 번 · 변화 칸을 빼고 결과 한 칸만
  const compare = label !== '통화에 쓰는 내용'
  return (
    <>
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
      {stopping && vm.stop && (
        <Confirm
          title="시험을 중단할까요?"
          ok="중단"
          danger
          busy={vm.stop.busy}
          error={vm.stop.error}
          onOk={vm.stop.run}
          onClose={() => setStopping(false)}
        >
          지금까지 돌린 결과는 남습니다. 통화에는 반영되지 않고, 다시 시험해야 반영할 수 있습니다.
        </Confirm>
      )}
      {vm.state === 'stale' && (
        <p
          role="status"
          className="shrink-0 rounded-lg border border-ops-wait/20 bg-ops-wait-soft px-4 py-2 text-[13px] text-ops-wait"
        >
          시험 뒤에 프롬프트를 고쳤습니다. 아래는 고치기 전 글의 결과입니다.
        </p>
      )}
      {/* 숫자 줄 (시안): 이름 13 · 숫자 24, 숫자 사이 36, 줄 높이 46 — 시험 전 · 중 · 뒤에도 표가 안 움직이게 높이를 잡아 둠 */}
      <div className="flex min-h-[46px] shrink-0 flex-wrap items-center gap-2">
        {vm.state === 'none' && <p className="text-[16px] font-bold">아직 시험하지 않았습니다</p>}
        {vm.progress && (
          <>
            <Stat label="진행" value={`${vm.progress.value} / ${vm.progress.max}`} />
            <progress
              aria-label="시험 진행"
              value={vm.progress.value}
              max={vm.progress.max}
              className="mr-3 h-2 w-[280px] appearance-none overflow-hidden rounded-full bg-ops-idle-soft [&::-moz-progress-bar]:bg-ops-route [&::-webkit-progress-bar]:bg-ops-idle-soft [&::-webkit-progress-value]:bg-ops-route"
            />
            <span className="text-[14px] text-ops-faint tabular-nums">통과 {vm.progress.pass}</span>
            <span className="text-[14px] text-ops-stop tabular-nums">실패 {vm.progress.fail}</span>
          </>
        )}
        {vm.summary?.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} tone={s.tone} className={dim} />
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {vm.stop && (
            <Btn
              kind="danger"
              onClick={() => {
                vm.stop?.reset() // 지난번 실패 문구가 새 창에 먼저 뜨지 않게
                setStopping(true)
              }}
            >
              시험 중단
            </Btn>
          )}
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
      <Box>
        <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto">
          {/* 다른 목록과 같은 표 (ops-table) — 업무 · 시나리오는 왼쪽, 결과 · 변화는 가운데 */}
          <table className={`ops-table ${dim}`}>
            <thead>
              <tr>
                <th scope="col" className="w-[120px]">
                  업무
                </th>
                <th scope="col" className="pl-[15px]! text-left!">
                  시나리오
                </th>
                {compare && (
                  <th scope="col" className="w-55">
                    통화에 쓰는 내용 <Date_>{vm.baseDate}</Date_>
                  </th>
                )}
                <th scope="col" className="w-55">
                  {label} <Date_>{vm.nowDate}</Date_>
                </th>
                {compare && (
                  <th scope="col" className="w-[140px]">
                    변화
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="[&_td:nth-child(n+3)]:text-center">
              {vm.rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => void navigate(r.to, { state: vm.from })}
                  className="cursor-pointer hover:bg-ops-route-soft"
                >
                  <td className="text-center text-ops-sub">{r.firstOfGroup && r.group}</td>
                  <td className="truncate text-left">
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
                  {compare && (
                    <td>
                      <Result cell={r.base} none="결과 없음" />
                    </td>
                  )}
                  <td>
                    <Result cell={r.now} none="-" />
                  </td>
                  {compare && (
                    <td className="text-ops-faint">
                      {r.change === '새로 실패' ? (
                        <Badge tone="stop">새로 실패</Badge>
                      ) : r.change === '새로 통과' ? (
                        <Badge tone="done">새로 통과</Badge>
                      ) : (
                        r.change || '-'
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Box>
    </>
  )
}

const Stat = ({
  label,
  value,
  tone = '',
  className = '',
}: {
  label: string
  value: string | number
  tone?: string // 숫자 색
  className?: string
}) => (
  <dl className={`mr-7 flex flex-col gap-0.5 ${className}`}>
    <dt className="text-[13px] leading-[15px] font-medium text-ops-sub">{label}</dt>
    <dd className={`text-[24px] leading-[29px] font-bold tabular-nums ${tone}`}>{value}</dd>
  </dl>
)

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
