// AI 상담가 (11/06) — 가운데 시스템 프롬프트 | 오른쪽 상담가 카드
// 11/11: 저장 = 새 버전, [적용] 없음. 오른쪽 위 탭([AI 상담가 유형] · [버전 히스토리]) → 버전 히스토리는 고른 상담가의 버전 기록(저장 시각 · 수정한 사람), 고른 버전이 가운데
// 데이터 · 규칙은 usePersonaPage. 등록 · 수정 창은 기존 부품을 그대로 씀. [시나리오 시험]은 따로 화면 (ScenarioTest)
import { useLocation, useNavigate } from 'react-router'
import { usePersonaPage, type PersonaItem } from '@/features/persona/hooks/usePersonaPage'
import { AddPersona } from './AddPersona'
import { PromptEditor } from './PromptEditor'
import { PageHead } from '@/shared/ui'
import { Badge, Btn, Icon } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'
import { Markdown } from '@/shared/ui/Markdown'

type Vm = ReturnType<typeof usePersonaPage>

// 사이드바의 [AI 상담가]를 다시 눌러도 location.key가 새로 생김 → 화면 상태를 통째로 버리고 처음(상담가 유형 탭)으로.
// 수정 중이면 PromptEditor의 useLeaveGuard가 그 이동을 먼저 막아 확인을 물음
export function PersonasPage() {
  return <PersonasView key={useLocation().key} />
}

function PersonasView() {
  const vm = usePersonaPage()
  const navigate = useNavigate()
  return (
    <>
      <PageHead title="AI 상담가">
        {vm.canAdd && !vm.editing && !vm.adding && (
          <Btn kind="primary" className="ml-auto" onClick={vm.openAdd}>
            <Icon name="plus" />
            상담가 등록
          </Btn>
        )}
      </PageHead>
      {vm.demo && (
        // 시연 모드 (11/09) — 고쳐 봐도 실서버 AI 상담가에는 안 감
        <p
          role="note"
          className="shrink-0 border-b border-ops-wait/20 bg-ops-wait-soft px-6 py-2 text-[13px] text-ops-wait"
        >
          시연 모드입니다. 여기서 저장 · 통화에 사용한 내용은 실제 AI 상담가에 반영되지 않고,
          새로고침하면 원래대로 돌아갑니다.
        </p>
      )}
      {vm.adding ? (
        // 등록 — 수정과 같은 넓은 화면 (11/11). 목록이 비어 있어도 첫 상담가를 만들 수 있게 맨 앞에서 가름
        <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
          <AddPersona onDone={vm.added} onClose={vm.closeAdd} />
        </div>
      ) : vm.error || vm.isLoading || vm.personas.length === 0 ? (
        <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
          {vm.error ?? (vm.isLoading ? '불러오는 중…' : '상담가가 없습니다.')}
        </p>
      ) : vm.editing && vm.editTarget ? (
        // 수정 — 등록과 같은 편집 화면 (저장 안 한 내용 확인 · 음성 드롭다운 포함)
        <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
          <PromptEditor target={vm.editTarget} onDone={vm.finishEdit} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section
            aria-label="시스템 프롬프트"
            className="flex min-w-0 flex-1 flex-col gap-3 px-6 py-4"
          >
            {/* 오른쪽은 그대로 두고 가운데만 로딩 */}
            {vm.promptLoading || !vm.prompt ? (
              <p className="flex flex-1 items-center justify-center text-[14px] text-ops-sub">
                불러오는 중…
              </p>
            ) : (
              <Prompt vm={vm} />
            )}
          </section>
          <aside aria-label="오른쪽 패널" className={ASIDE}>
            <PanelTabs vm={vm} />
            <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto">
              {vm.historyOpen ? <History vm={vm} /> : <Personas vm={vm} />}
            </div>
          </aside>
        </div>
      )}
      {vm.confirm && (
        <Confirm
          title={vm.confirm.title}
          ok={vm.confirm.okLabel}
          danger={vm.confirm.danger}
          busy={vm.confirmBusy}
          disabled={vm.confirm.blocked}
          extra={
            vm.confirm.testTo && (
              // 시험 전이면 이 버튼이 주 버튼 + 첫 초점 (끈 확인 버튼엔 초점이 못 감)
              <Btn
                kind={vm.confirm.blocked ? 'primary' : 'line'}
                data-autofocus={vm.confirm.blocked || undefined}
                onClick={() => void navigate(vm.confirm!.testTo!)}
              >
                시나리오 시험
              </Btn>
            )
          }
          error={vm.confirmError}
          onOk={vm.confirmOk}
          onClose={vm.confirmCancel}
        >
          {/* 통화에 사용 중인 버전과 달라진 수만 (11/12 사용자: 이름을 다 띄우지 않음 — 이름은 뒤의 표에) */}
          {vm.confirm.changes && vm.confirm.changes.fail + vm.confirm.changes.pass > 0 && (
            <p className="mb-2 font-bold">
              <span className="text-ops-stop">새로 실패 {vm.confirm.changes.fail}개</span>,{' '}
              <span className="text-ops-done">새로 통과 {vm.confirm.changes.pass}개</span>
            </p>
          )}
          {vm.confirm.note}
        </Confirm>
      )}
    </>
  )
}

// 오른쪽 패널 틀 — 카드 목록 · 버전 기록이 같은 자리 · 같은 폭
const ASIDE =
  'flex w-96 shrink-0 flex-col gap-2 overflow-hidden border-l border-ops-line bg-white p-4 max-xl:w-80'

// 오른쪽 위 탭
function PanelTabs({ vm }: { vm: Vm }) {
  return (
    <LineTabs
      label="오른쪽 패널"
      className="px-1"
      tabs={[
        { label: 'AI 상담가 유형', on: !vm.historyOpen, pick: vm.closeHistory },
        { label: '버전 히스토리', on: vm.historyOpen, pick: vm.openHistory },
      ]}
    />
  )
}

// 밑줄이 따라다니는 탭 (11/11 사용자 시안) — 오른쪽 패널. 이 화면에서만 써서 shared/ui엔 안 올림
function LineTabs({
  label,
  tabs,
  className,
}: {
  label: string
  tabs: { label: string; on: boolean; pick: () => void }[]
  className: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={`flex shrink-0 gap-5 border-b border-ops-line ${className}`}
    >
      {tabs.map((t) => (
        <button
          key={t.label}
          type="button"
          role="tab"
          aria-selected={t.on}
          onClick={t.pick}
          className={`-mb-px border-b-2 pb-2 text-[15px] font-bold outline-none focus-visible:text-ops-route ${t.on ? 'border-ops-route text-ops-route' : 'border-transparent text-ops-sub hover:text-ops-ink'}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

function Personas({ vm }: { vm: Vm }) {
  return (
    <div className="flex flex-col gap-2 pt-1">
      {vm.personas.map((p) => (
        <PersonaCard key={p.personaSeq} p={p} vm={vm} />
      ))}
    </div>
  )
}

// 이름 · 태그 → 음성 → [통화에 사용하기](통화에 안 쓰는 상담가) · [삭제](빨강, 사용 중 · 적용 대기가 아닐 때)
function PersonaCard({ p, vm }: { p: PersonaItem; vm: Vm }) {
  return (
    <div
      className={`rounded-xl px-5 py-4 ${p.selected ? 'bg-ops-route-soft' : 'hover:bg-ops-paper'}`}
    >
      <button
        type="button"
        onClick={() => vm.selectPersona(p.personaSeq)}
        className="w-full text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className={`text-[15px] font-bold ${p.selected ? 'text-ops-route' : ''}`}>
            {p.name}
          </span>
          {p.inUse && <Badge tone="done">통화에 사용 중</Badge>}
          {p.applying && <Badge tone="wait">{p.applying}</Badge>}
        </span>
        <span className="mt-1 block text-[13px] text-ops-sub">{p.voice}</span>
      </button>
      {(p.canUse || p.deletable) && (
        <div className="mt-3 flex gap-2">
          {p.canUse && (
            <Btn kind="lineBadge" onClick={() => vm.askUse(p.personaSeq)}>
              통화에 사용하기
            </Btn>
          )}
          {p.deletable && (
            <Btn kind="dangerBadge" onClick={() => vm.askDelete(p.personaSeq)}>
              삭제
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}

// 버전 기록 (11/11, Notion 버전 기록처럼) — 저장 시각 · 태그 → 그 버전의 음성 → 수정한 사람(모르면 줄 숨김). 누르면 가운데에 그 버전
// 통화에 아직 안 쓰인 현재 버전 줄엔 [통화에 반영하기] (11/13) — 줄 버튼 안에 버튼을 못 넣어 형제로 둠 (카드와 같은 모양)
function History({ vm }: { vm: Vm }) {
  return (
    <div className="flex flex-col gap-2 pt-1">
      <p className="truncate px-1 text-[13px] text-ops-sub">{vm.historyTitle}</p>
      <ol className="flex flex-col gap-1">
        {vm.history.map((h) => (
          <li
            key={h.version}
            className={`rounded-xl px-4 py-3 ${h.selected ? 'bg-ops-route-soft' : 'hover:bg-ops-paper'}`}
          >
            <button
              type="button"
              aria-current={h.selected || undefined}
              onClick={() => vm.selectVersion(h.version)}
              className="w-full text-left"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className={`text-[15px] ${h.selected ? 'font-bold text-ops-route' : ''}`}>
                  {h.time}
                </span>
                {h.badges.map((b) => (
                  <Badge key={b.label} tone={b.tone}>
                    {b.label}
                  </Badge>
                ))}
              </span>
              <span className="mt-1 block text-[13px] text-ops-sub">{h.voice}</span>
              {h.rename && (
                <span className="mt-1 block text-[13px] break-all text-ops-sub">
                  <span className="sr-only">이름 변경: </span>
                  {h.rename.from} <span aria-hidden>→</span>
                  <span className="sr-only">에서</span>{' '}
                  <span className="text-ops-route">{h.rename.to}</span>
                </span>
              )}
              {h.author && (
                <span className="mt-1 flex items-center gap-1.5 text-[13px] text-ops-sub">
                  <span aria-hidden className="size-2 rounded-full bg-ops-route" />
                  {h.author}
                </span>
              )}
            </button>
            {h.apply && (
              <Btn kind="lineBadge" className="mt-3" onClick={vm.applyHead}>
                통화에 반영하기
              </Btn>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

function Prompt({ vm }: { vm: Vm }) {
  const p = vm.prompt!
  const navigate = useNavigate()
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ops-line bg-white">
      <header className="flex flex-wrap items-center gap-3 border-b border-ops-line px-5 py-3">
        <span className="text-[15px] font-bold">{p.time}</span>
        {p.badges.map((b) => (
          <Badge key={b.label} tone={b.tone}>
            {b.label}
          </Badge>
        ))}
        {p.author && <span className="text-[13px] text-ops-sub">{p.author}</span>}
        <span className="ml-auto flex flex-wrap gap-2">
          {p.reuse?.hint && (
            <span className="self-center text-[13px] text-ops-sub">{p.reuse.hint}</span>
          )}
          {p.reuse && (
            <Btn kind="editBadge" disabled={p.reuse.disabled} onClick={vm.askReuse}>
              이 버전 다시 쓰기
            </Btn>
          )}
          {p.canEdit && (
            <Btn kind="editBadge" onClick={vm.startEdit}>
              프롬프트 수정
            </Btn>
          )}
          {vm.testTo && (
            // 보고 있는 버전의 시험 화면으로 (11/12 사용자: 탭 대신 버튼 + 전체 화면, 가짜 시험 통화는 없앰)
            <Btn kind="plainBadge" onClick={() => void navigate(vm.testTo!)}>
              시나리오 시험
            </Btn>
          )}
        </span>
      </header>
      <PromptBody p={p} />
    </article>
  )
}

// 칸 제목은 고정 글, 본문만 마크다운 (11/10)
function PromptBody({ p }: { p: NonNullable<Vm['prompt']> }) {
  return (
    <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-8 py-6">
      {p.sections.map((s) => (
        <section key={s.key} className="mb-7 last:mb-0">
          {s.group && <h3 className="mb-4 text-[18px] font-bold">{s.group}</h3>}
          {/* 제목 단계도 서버 글과 같게: 발화 스타일 아래 톤 · 속도만 한 단계 아래 (화면 읽기 프로그램) */}
          {s.sub ? (
            <h4 className="mb-2 text-[15px] font-bold">{s.title}</h4>
          ) : (
            <h3 className="mb-2 text-[18px] font-bold">{s.title}</h3>
          )}
          {s.rows ? (
            // 현재 버전 기준: 빠진 말 = 파란 취소선, 더해진 말 = 파란 강조. 같은 문단에 이어 붙임 (줄 단위라 마크다운은 풀지 않음)
            <div className="pl-4 text-[14px] leading-6">
              {s.rows.map((r) => (
                <p key={r.key} className="whitespace-pre-wrap">
                  {r.parts.map((x, i) =>
                    x.kind === 'del' ? (
                      <del key={i} className="decoration-ops-route">
                        <span className="sr-only">빠진 말: </span>
                        {x.text}
                      </del>
                    ) : x.kind === 'add' ? (
                      <ins key={i} className="bg-ops-route-soft text-ops-route no-underline">
                        <span className="sr-only">더한 말: </span>
                        {x.text}
                      </ins>
                    ) : (
                      x.text || ' '
                    ),
                  )}
                </p>
              ))}
            </div>
          ) : (
            <Markdown text={s.text} className="pl-4 text-[14px] leading-6" />
          )}
        </section>
      ))}
    </div>
  )
}
