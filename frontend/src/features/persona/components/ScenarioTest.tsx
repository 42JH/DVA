// AI 상담가 가운데 카드의 [시나리오 시험] 탭 (11/12, Figma 1919:7975) — 가짜 모드에서만
// 위: 상태(시험 전 · 시험 중 진행 · 끝난 뒤 요약) + [전체 시험] (핵심 묶음은 화면에서 뺌, 11/12 사용자: 기준이 헷갈림). 아래: 업무 · 시나리오 · 통화에 사용 중 · 이 버전 · 변화
// 줄을 누르면 그 통화의 상세(대화 · 결과표 · 녹음). 시험 뒤 글을 고쳤으면 고치기 전 결과를 흐리게 + 안내 한 줄
import { Link, useNavigate } from 'react-router'
import { Badge, Btn } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'
import type { Cell } from '@/features/persona/hooks/scenarioTest'
import { useScenarioTest } from '@/features/persona/hooks/useScenarioTest'

export function ScenarioTest({
  me,
  dateOf,
}: {
  me: { personaSeq: number; version: number; isHead: boolean }
  dateOf: (version: number) => string
}) {
  const vm = useScenarioTest(me, dateOf)
  const navigate = useNavigate()
  if (vm.note)
    return (
      <p className="flex flex-1 items-center justify-center text-[14px] text-ops-sub">{vm.note}</p>
    )
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
        <p role="status" className="shrink-0 bg-ops-wait-soft px-5 py-2 text-[13px] text-ops-wait">
          시험 뒤에 프롬프트를 고쳤습니다. 아래는 고치기 전 글의 결과입니다.
        </p>
      )}
      <div className="flex min-h-[68px] shrink-0 flex-wrap items-center gap-x-10 gap-y-2 px-5 py-3">
        {vm.state === 'none' && (
          <p className="text-[15px] font-bold">이 버전은 아직 시험하지 않았습니다</p>
        )}
        {vm.progress && (
          <div className="flex flex-col gap-2">
            <p className="text-[15px] font-bold">
              {vm.progress.text}
              <span className="ml-2 text-[13px] font-normal text-ops-sub">
                {vm.progress.started}
              </span>
            </p>
            <progress
              value={vm.progress.value}
              max={vm.progress.max}
              className="h-1.5 w-80 appearance-none overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-ops-line [&::-webkit-progress-value]:bg-ops-route"
            />
          </div>
        )}
        {vm.summary?.map((s) => (
          <dl key={s.label} className={dim}>
            <dt className="text-[12px] text-ops-sub">{s.label}</dt>
            <dd className={`text-[20px] leading-7 font-bold tabular-nums ${s.tone}`}>{s.value}</dd>
          </dl>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ops-sub">{vm.finished}</span>
          {vm.canRun && (
            <>
              {vm.retryLabel && (
                <Btn kind="plainBadge" onClick={vm.retry}>
                  {vm.retryLabel}
                </Btn>
              )}
              <Btn kind="lineBadge" onClick={vm.runAll}>
                {vm.allLabel}
              </Btn>
            </>
          )}
        </span>
      </div>
      <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto">
        <table className={`w-full table-fixed text-[13px] ${dim}`}>
          <thead className="sticky top-0 bg-ops-paper text-left text-ops-sub">
            <tr className="h-9 [&>th]:text-left! [&>th]:font-medium">
              <th scope="col" className="w-28 pl-5">
                업무
              </th>
              <th scope="col">시나리오</th>
              <th scope="col" className="w-44">
                통화에 사용 중 <Date_>{vm.baseDate}</Date_>
              </th>
              <th scope="col" className="w-44">
                이 버전 <Date_>{vm.nowDate}</Date_>
              </th>
              <th scope="col" className="w-24">
                변화
              </th>
            </tr>
          </thead>
          <tbody className="[&_td]:text-left">
            {vm.rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => void navigate(r.to)}
                className={`h-9 border-t ${r.firstOfGroup ? 'border-ops-line' : 'border-ops-line/50'} cursor-pointer hover:bg-ops-paper`}
              >
                <td className="pl-5 text-ops-sub">{r.firstOfGroup && r.group}</td>
                <td className="truncate pr-3">
                  {/* 줄 전체가 눌리지만 키보드로는 이 링크로 (줄의 onClick과 겹쳐 두 번 이동하지 않게 막음) */}
                  <Link
                    to={r.to}
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
