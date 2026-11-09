// v2 AI 상담가 (11/06) — 왼쪽 상담가 목록 | 가운데 시스템 프롬프트(또는 버전 비교) | 오른쪽 버전 기록
// 데이터 · 적용 · 시험 통화 · 수정 규칙은 기존 usePersonaPage 그대로. 프롬프트 수정 · 추가 · 시험 통화 창은 기존 부품을 v2 틀 안에서 씀
import {
  usePersonaPage,
  type PersonaItem,
  type VersionItem,
} from '@/features/persona/hooks/usePersonaPage'
import { AddPersonaModal } from '@/features/persona/components/AddPersonaModal'
import { PromptEditor } from '@/features/persona/components/PromptEditor'
import { TestCallModal } from '@/features/persona/components/TestCallModal'
import { PageHead } from '@/v2/V2Layout'
import { PERSONA_DEMO } from '@/features/persona/api/personaApi'
import type { TagKind } from '@/shared/ui'
import { Badge, Btn, Icon, type Tone } from '@/v2/ui'
import { Confirm } from '@/v2/ui/Modal'

type Vm = ReturnType<typeof usePersonaPage>
// 기존 태그 색 이름 → v2 뱃지 색 (적용 중 = live, 저장됨 = blue, 대기 = outline)
const TAG_TONE: Record<TagKind, Tone> = {
  live: 'done',
  blue: 'route',
  outline: 'wait',
  red: 'stop',
  gray: 'idle',
}

export function PersonasPage() {
  const vm = usePersonaPage()
  return (
    <>
      <PageHead title="AI 상담가">
        {vm.canAdd && !vm.editing && (
          <Btn kind="primary" className="ml-auto" onClick={vm.openAdd}>
            <Icon name="bot" />
            상담가 등록
          </Btn>
        )}
      </PageHead>
      {PERSONA_DEMO && (
        // 시연 모드 (11/09) — 고쳐 봐도 실서버 AI 상담가에는 안 감
        <p
          role="note"
          className="shrink-0 border-b border-ops-wait/20 bg-ops-wait-soft px-6 py-2 text-[13px] text-ops-wait"
        >
          시연 모드입니다. 여기서 저장 · 적용한 내용은 실제 AI 상담가에 반영되지 않고, 새로고침하면
          원래대로 돌아갑니다.
        </p>
      )}
      {vm.error || vm.isLoading || !vm.prompt || !vm.editTarget ? (
        <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
          {vm.error ?? (vm.isLoading ? '불러오는 중…' : '상담가가 없습니다.')}
        </p>
      ) : vm.editing ? (
        // 수정 — 기존 편집기 그대로 (저장 안 한 내용 확인 · 음성 세부 조절 포함)
        <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
          <PromptEditor target={vm.editTarget} onDone={vm.finishEdit} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <Personas vm={vm} />
          <section
            aria-label="시스템 프롬프트"
            className="flex min-w-0 flex-1 flex-col gap-3 px-6 py-4"
          >
            {vm.compare ? <Compare vm={vm} /> : <Prompt vm={vm} />}
          </section>
          <Versions vm={vm} />
        </div>
      )}
      {vm.applyConfirm && (
        <Confirm
          title={vm.applyConfirm.title}
          ok={vm.applyConfirm.okLabel}
          busy={vm.isApplying}
          error={vm.applyError}
          onOk={vm.confirmApply}
          onClose={vm.cancelApply}
        >
          {vm.applyConfirm.note}
        </Confirm>
      )}
      {vm.adding && <AddPersonaModal onDone={vm.added} onClose={vm.closeAdd} />}
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

function Personas({ vm }: { vm: Vm }) {
  return (
    <nav
      aria-label="상담가"
      className="flex w-64 shrink-0 flex-col gap-1 overflow-y-auto border-r border-ops-line bg-white px-3 py-4 max-xl:w-56"
    >
      {vm.personas.map((p) => (
        <PersonaRow key={p.personaSeq} p={p} vm={vm} />
      ))}
    </nav>
  )
}

function PersonaRow({ p, vm }: { p: PersonaItem; vm: Vm }) {
  return (
    <div
      className={`rounded-md px-3 py-2.5 ${p.selected ? 'bg-ops-route-soft' : 'hover:bg-ops-paper'}`}
    >
      <button
        type="button"
        onClick={() => vm.selectPersona(p.personaSeq)}
        className="w-full text-left"
      >
        <span className="flex items-center gap-1.5">
          <span className={`text-[14px] font-semibold ${p.selected ? 'text-ops-route' : ''}`}>
            {p.name}
          </span>
          {p.inUse && <Badge tone="done">통화에 사용 중</Badge>}
          {p.applying && <Badge tone="wait">{p.applying}</Badge>}
        </span>
        {p.lines.map((l) => (
          <span key={l} className="block text-[12px] text-ops-sub">
            {l}
          </span>
        ))}
        <span className="block text-[12px] text-ops-faint">{p.versionLine}</span>
      </button>
      {p.canUse && (
        <Btn className="mt-2" onClick={() => vm.askUse(p.personaSeq)}>
          통화에 사용하기
        </Btn>
      )}
    </div>
  )
}

function Prompt({ vm }: { vm: Vm }) {
  const p = vm.prompt!
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ops-line bg-white">
      <header className="flex flex-wrap items-center gap-3 border-b border-ops-line px-5 py-3">
        <span className="text-[15px] font-bold">{p.tag}</span>
        <span className="text-[13px] text-ops-sub">{p.subtitle}</span>
        <span className="ml-auto flex gap-2">
          {p.compareLabel && <Btn onClick={vm.startCompare}>{p.compareLabel}</Btn>}
          {p.canEdit && <Btn onClick={vm.startVoice}>음성 세부 조절</Btn>}
          {p.canEdit && (
            <Btn kind="warning" onClick={vm.startEdit}>
              프롬프트 수정
            </Btn>
          )}
        </span>
      </header>
      <ol className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto py-3 font-[inherit] text-[14px] leading-6">
        {p.lines.map((l) => (
          <li key={l.no} className="grid grid-cols-[48px_1fr] px-2">
            <span className="pr-3 text-right text-[12px] text-ops-faint tabular-nums select-none">
              {l.no}
            </span>
            <span className={`pr-4 whitespace-pre-wrap ${l.heading ? 'pt-2 font-bold' : ''}`}>
              {l.text || ' '}
            </span>
          </li>
        ))}
      </ol>
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
        <Btn className="ml-auto" onClick={vm.closeCompare}>
          비교 닫기
        </Btn>
      </header>
      <ol className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto py-2 text-[14px] leading-6">
        {c.rows.map((r) => (
          <li
            key={r.key}
            className={`grid grid-cols-[40px_40px_20px_1fr] px-2 ${r.kind === 'del' ? 'bg-ops-stop-soft' : r.kind === 'add' ? 'bg-ops-done-soft' : ''}`}
          >
            <span className="text-right text-[12px] text-ops-faint tabular-nums">
              {r.from ?? ''}
            </span>
            <span className="text-right text-[12px] text-ops-faint tabular-nums">{r.to ?? ''}</span>
            <span className={`text-center ${r.kind === 'del' ? 'text-ops-stop' : 'text-ops-done'}`}>
              {r.kind === 'del' ? '−' : r.kind === 'add' ? '+' : ''}
            </span>
            <span className="pr-4 whitespace-pre-wrap">{r.text || ' '}</span>
          </li>
        ))}
      </ol>
    </article>
  )
}

function Versions({ vm }: { vm: Vm }) {
  return (
    <aside
      aria-label="버전 기록"
      className="flex w-80 shrink-0 flex-col border-l border-ops-line bg-white max-xl:w-72"
    >
      <h2 className="flex h-11 shrink-0 items-center border-b border-ops-line px-4 text-[13px] font-semibold">
        버전 기록
      </h2>
      <ul className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-3 py-3">
        {vm.versions.map((v) => (
          <VersionRow key={v.version} v={v} vm={vm} />
        ))}
        {vm.moreVersions > 0 && (
          <li className="pt-2 text-center">
            <Btn kind="ghost" onClick={vm.showAllVersions}>
              이전 버전 더 보기
            </Btn>
          </li>
        )}
      </ul>
    </aside>
  )
}

function VersionRow({ v, vm }: { v: VersionItem; vm: Vm }) {
  return (
    <li
      className={`mb-1 rounded-md px-3 py-2.5 ${v.selected ? 'bg-ops-route-soft' : 'hover:bg-ops-paper'}`}
    >
      <button
        type="button"
        onClick={() => vm.selectVersion(v.version)}
        className="w-full text-left"
      >
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-[14px] font-semibold tabular-nums">v{v.version}</span>
          {v.tags.map((t) => (
            <Badge key={t.label} tone={TAG_TONE[t.kind]}>
              {t.label}
            </Badge>
          ))}
          <span className="ml-auto text-[12px] text-ops-faint tabular-nums">{v.date}</span>
        </span>
        <span className="mt-0.5 block text-[13px] text-ops-ink/80">{v.summary}</span>
        <span className="block text-[12px] text-ops-faint">
          {v.author}
          {v.testResult && `, 시험 통화 ${v.testResult}`}
        </span>
      </button>
      <span className="mt-2 flex gap-1.5">
        <Btn onClick={() => vm.startTestCall(v.version)}>시험 통화</Btn>
        {v.canApply && (
          <Btn
            kind="primary"
            disabled={!v.canApplyNow}
            title={v.canApplyNow ? undefined : '시험 통화를 끝낸 버전만 적용할 수 있습니다'}
            onClick={vm.askApply}
          >
            적용
          </Btn>
        )}
      </span>
    </li>
  )
}
