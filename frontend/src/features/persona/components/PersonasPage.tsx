// AI 상담가 (11/06) — 가운데 시스템 프롬프트(또는 비교) | 오른쪽 상담가 카드
// 11/11: 저장 = 새 버전, [적용] 없음. 카드 케밥(⋮) → 오른쪽이 그 상담가의 버전 기록(저장 시각 · 수정한 사람), 고른 버전이 가운데
// 데이터 · 규칙은 usePersonaPage. 등록 · 수정 · 시험 통화 창은 기존 부품을 그대로 씀
import { usePersonaPage, type PersonaItem } from '@/features/persona/hooks/usePersonaPage'
import { AddPersona } from './AddPersona'
import { PromptEditor } from './PromptEditor'
import { TestCallModal } from './TestCallModal'
import { PageHead } from '@/shared/ui'
import { Badge, Btn, Icon, KebabMenu } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'
import { Markdown } from '@/shared/ui/Markdown'

type Vm = ReturnType<typeof usePersonaPage>

export function PersonasPage() {
  const vm = usePersonaPage()
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
            ) : vm.compare ? (
              <Compare vm={vm} />
            ) : (
              <Prompt vm={vm} />
            )}
          </section>
          {vm.historyOpen ? <History vm={vm} /> : <Personas vm={vm} />}
        </div>
      )}
      {vm.confirm && (
        <Confirm
          title={vm.confirm.title}
          ok={vm.confirm.okLabel}
          busy={vm.confirmBusy}
          error={vm.confirmError}
          onOk={vm.confirmOk}
          onClose={vm.confirmCancel}
        >
          {vm.confirm.note}
        </Confirm>
      )}
      {vm.testCall && (
        <TestCallModal
          key={`${vm.testCall.personaSeq}-${vm.testCall.version}`}
          target={vm.testCall}
          onEnd={vm.endTestCall}
        />
      )}
    </>
  )
}

// 오른쪽 패널 틀 — 카드 목록 · 버전 기록이 같은 자리 · 같은 폭
const ASIDE =
  'flex w-96 shrink-0 [scrollbar-width:thin] flex-col gap-2 overflow-y-auto border-l border-ops-line bg-white p-4 max-xl:w-80'

function Personas({ vm }: { vm: Vm }) {
  return (
    <aside aria-label="상담가" className={ASIDE}>
      {vm.personas.map((p) => (
        <PersonaCard key={p.personaSeq} p={p} vm={vm} />
      ))}
    </aside>
  )
}

// 이름 · 태그 → 음성 → (사용 중인데 새 버전이 있으면) 안내 → [통화에 사용하기]. 오른쪽 위 ⋮ = 메뉴 → 버전 기록 (11/11)
function PersonaCard({ p, vm }: { p: PersonaItem; vm: Vm }) {
  return (
    <div
      className={`relative rounded-xl px-5 py-4 ${p.selected ? 'bg-ops-route-soft' : 'hover:bg-ops-paper'}`}
    >
      <button
        type="button"
        onClick={() => vm.selectPersona(p.personaSeq)}
        className="w-full pr-8 text-left"
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className={`text-[15px] font-bold ${p.selected ? 'text-ops-route' : ''}`}>
            {p.name}
          </span>
          {p.inUse && <Badge tone="done">통화에 사용 중</Badge>}
          {p.applying && <Badge tone="wait">{p.applying}</Badge>}
        </span>
        {p.lines.map((l) => (
          <span key={l} className="mt-1 block text-[13px] text-ops-sub">
            {l}
          </span>
        ))}
        {p.note && <span className="mt-1 block text-[13px] text-ops-wait">{p.note}</span>}
      </button>
      <div className="absolute top-3 right-3">
        <KebabMenu
          label={`${p.name} 메뉴`}
          items={[{ label: '버전 기록', onSelect: () => vm.openHistory(p.personaSeq) }]}
        />
      </div>
      {p.useLabel && (
        <Btn kind="lineBadge" className="mt-3" onClick={() => vm.askUse(p.personaSeq)}>
          {p.useLabel}
        </Btn>
      )}
    </div>
  )
}

// 버전 기록 (11/11, Notion 버전 기록처럼) — 저장 시각 · 태그 → 그 버전의 음성 → 수정한 사람(모르면 줄 숨김). 누르면 가운데에 그 버전
function History({ vm }: { vm: Vm }) {
  return (
    <aside aria-label="버전 기록" className={ASIDE}>
      <header className="flex items-start gap-2 px-1 pb-2">
        <button
          type="button"
          aria-label="버전 기록 닫기"
          onClick={vm.closeHistory}
          className="grid size-8 shrink-0 place-items-center rounded-md text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
        >
          <Icon name="arrowLeft" />
        </button>
        <span className="min-w-0">
          <span className="block text-[12px] text-ops-sub">버전 기록</span>
          <span className="block truncate text-[16px] font-bold">{vm.historyTitle}</span>
        </span>
      </header>
      <ol className="flex flex-col gap-1">
        {vm.history.map((h) => (
          <li key={h.version}>
            <button
              type="button"
              aria-current={h.selected || undefined}
              onClick={() => vm.selectVersion(h.version)}
              className={`w-full rounded-xl px-4 py-3 text-left ${h.selected ? 'bg-ops-route-soft' : 'hover:bg-ops-paper'}`}
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
              {h.author && (
                <span className="mt-1 flex items-center gap-1.5 text-[13px] text-ops-sub">
                  <span aria-hidden className="size-2 rounded-full bg-ops-route" />
                  {h.author}
                </span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </aside>
  )
}

function Prompt({ vm }: { vm: Vm }) {
  const p = vm.prompt!
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
          <Btn kind="plainBadge" onClick={vm.startTestCall}>
            시험 통화
          </Btn>
          {p.past && (
            <Btn kind="plainBadge" onClick={vm.startCompare}>
              현재 버전과 비교
            </Btn>
          )}
          {p.reuse && (
            <Btn
              kind="editBadge"
              disabled={p.reuse.disabled}
              title={p.reuse.hint}
              onClick={vm.askReuse}
            >
              이 버전 다시 쓰기
            </Btn>
          )}
          {p.canEdit && (
            <Btn kind="editBadge" onClick={vm.startEdit}>
              프롬프트 수정
            </Btn>
          )}
        </span>
      </header>
      {/* 칸 제목은 고정 글, 본문만 마크다운 (11/10) */}
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
            <Markdown text={s.text} className="pl-4 text-[14px] leading-6" />
          </section>
        ))}
      </div>
    </article>
  )
}

function Compare({ vm }: { vm: Vm }) {
  const c = vm.compare!
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ops-line bg-white">
      <header className="flex flex-wrap items-center gap-3 border-b border-ops-line px-5 py-3 text-[13px]">
        <span className="font-bold">
          {c.base} ({c.baseTag})에서 {c.target} ({c.targetTag})로
        </span>
        <span className="text-ops-stop">빠진 줄 {c.removed}</span>
        <span className="text-ops-done">더한 줄 {c.added}</span>
        <Btn kind="plainBadge" className="ml-auto" onClick={vm.closeCompare}>
          비교 닫기
        </Btn>
      </header>
      <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto py-2 text-[14px] leading-6">
        {c.sections.map((s) => (
          <section key={s.key} className="mb-4 last:mb-0">
            {s.group && <h3 className="px-4 pt-2 text-[15px] font-bold">{s.group}</h3>}
            <h4 className="flex items-baseline gap-2 px-4 py-1.5 font-bold">
              {s.title}
              {/* 안 바뀐 칸은 줄을 다 펼치지 않음 — 바뀐 칸만 눈에 띄게 */}
              {!s.changed && (
                <span className="text-[12px] font-normal text-ops-faint">변경 없음</span>
              )}
            </h4>
            {s.changed && (
              <ol>
                {s.rows.map((r) => (
                  <li
                    key={r.key}
                    className={`grid grid-cols-[40px_40px_20px_1fr] px-2 ${r.kind === 'del' ? 'bg-ops-stop-soft' : r.kind === 'add' ? 'bg-ops-done-soft' : ''}`}
                  >
                    <span className="text-right text-[12px] text-ops-faint tabular-nums">
                      {r.from ?? ''}
                    </span>
                    <span className="text-right text-[12px] text-ops-faint tabular-nums">
                      {r.to ?? ''}
                    </span>
                    <span
                      className={`text-center ${r.kind === 'del' ? 'text-ops-stop' : 'text-ops-done'}`}
                    >
                      {r.kind === 'del' ? '−' : r.kind === 'add' ? '+' : ''}
                    </span>
                    <span className="pr-4 whitespace-pre-wrap">{r.text || ' '}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>
    </article>
  )
}
