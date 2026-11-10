// AI 상담가 (11/06) — 가운데 시스템 프롬프트(또는 버전 비교) | 오른쪽 상담가 카드 (11/10: 왼쪽 목록 · 버전 기록을 카드 + 히스토리 드롭다운으로 합침)
// 데이터 · 적용 · 시험 통화 · 수정 규칙은 기존 usePersonaPage 그대로. 프롬프트 수정 · 추가 · 시험 통화 창은 기존 부품을 그대로 씀
import { usePersonaPage, type PersonaItem } from '@/features/persona/hooks/usePersonaPage'
import { AddPersonaModal } from './AddPersonaModal'
import { PromptEditor } from './PromptEditor'
import { TestCallModal } from './TestCallModal'
import { PageHead } from '@/shared/ui'
import { Badge, Btn, Icon } from '@/shared/ui'
import { SelectInput } from '@/shared/ui/Field'
import { Confirm } from '@/shared/ui/Modal'
import { Markdown } from '@/shared/ui/Markdown'

type Vm = ReturnType<typeof usePersonaPage>

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
      {vm.demo && (
        // 시연 모드 (11/09) — 고쳐 봐도 실서버 AI 상담가에는 안 감
        <p
          role="note"
          className="shrink-0 border-b border-ops-wait/20 bg-ops-wait-soft px-6 py-2 text-[13px] text-ops-wait"
        >
          시연 모드입니다. 여기서 저장 · 적용한 내용은 실제 AI 상담가에 반영되지 않고, 새로고침하면
          원래대로 돌아갑니다.
        </p>
      )}
      {vm.error || vm.isLoading || vm.personas.length === 0 ? (
        <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
          {vm.error ?? (vm.isLoading ? '불러오는 중…' : '상담가가 없습니다.')}
        </p>
      ) : vm.editing && vm.editTarget ? (
        // 수정 — 기존 편집기 그대로 (저장 안 한 내용 확인 · 음성 세부 조절 포함)
        <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
          <PromptEditor target={vm.editTarget} onDone={vm.finishEdit} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section
            aria-label="시스템 프롬프트"
            className="flex min-w-0 flex-1 flex-col gap-3 px-6 py-4"
          >
            {/* 오른쪽 카드는 그대로 두고 가운데만 로딩 */}
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
          <Personas vm={vm} />
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
    <aside
      aria-label="상담가"
      className="flex w-96 shrink-0 [scrollbar-width:thin] flex-col gap-2 overflow-y-auto border-l border-ops-line bg-white p-4 max-xl:w-80"
    >
      {vm.personas.map((p) => (
        <PersonaCard key={p.personaSeq} p={p} vm={vm} />
      ))}
    </aside>
  )
}

// 와이어프레임 11/10: 이름(가운데 헤더 버전 글씨 크기) · 태그 → 음성 · 적용 버전 → (고른 카드만) 히스토리 드롭다운 → 그 아래 [시험 통화] [적용] → [통화에 사용하기]
function PersonaCard({ p, vm }: { p: PersonaItem; vm: Vm }) {
  const h = p.history
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
        {p.lines.map((l) => (
          <span key={l} className="mt-1 block text-[13px] text-ops-sub">
            {l}
          </span>
        ))}
        <span className="block text-[13px] text-ops-sub">{p.versionLine}</span>
      </button>
      {h && (
        <div className="mt-3 flex flex-col gap-2">
          <SelectInput
            label="히스토리"
            value={h.value}
            onChange={vm.selectVersion}
            options={h.options}
          />
          <span className="flex gap-2">
            <Btn onClick={vm.startTestCall}>시험 통화</Btn>
            {h.canApply && (
              <Btn
                kind="primary"
                disabled={!h.canApplyNow}
                title={h.canApplyNow ? undefined : '시험 통화를 끝낸 버전만 적용할 수 있습니다'}
                onClick={vm.askApply}
              >
                적용
              </Btn>
            )}
          </span>
        </div>
      )}
      {p.canUse && (
        <Btn className="mt-3" onClick={() => vm.askUse(p.personaSeq)}>
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
        <Btn className="ml-auto" onClick={vm.closeCompare}>
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
