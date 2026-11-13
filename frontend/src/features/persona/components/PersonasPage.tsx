// AI 상담가 (11/13 새 안, 피그마 2368:2525) — 위 탭으로 상담가 고르기 | 카드 = 머리 줄(이름 · 목소리 · 저장 시각 · 버튼) + 프롬프트
// 11/11: 저장 = 새 버전, [적용] 없음. 버전 기록은 5단계 수정 기록 창으로 옮김
// 데이터 · 규칙은 usePersonaPage. 등록 · 수정 창은 기존 부품을 그대로 씀. [시나리오 시험]은 따로 화면 (ScenarioTest)
import { useLocation, useNavigate } from 'react-router'
import { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { AddPersona } from './AddPersona'
import { PromptEditor } from './PromptEditor'
import { PageHead } from '@/shared/ui'
import { Badge, Btn, Icon, Segments } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'

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
      <PageHead title="AI 상담가" />
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
        <div className="flex min-h-0 flex-1 flex-col gap-4 px-6 py-4">
          <div className="flex items-center gap-2">
            <Segments
              label="상담가"
              value={String(vm.current?.personaSeq ?? '')}
              items={vm.personas.map((p) => ({
                value: String(p.personaSeq),
                label: p.name,
                badge: p.inUse && <Badge tone="done">사용 중</Badge>,
              }))}
              onPick={(v) => vm.selectPersona(Number(v))}
            />
            {vm.canAdd && (
              <Btn kind="line" className="ml-auto" onClick={vm.openAdd}>
                <Icon name="plus" />
                상담가 등록
              </Btn>
            )}
          </div>
          {/* 탭은 그대로 두고 카드만 로딩 */}
          {vm.promptLoading || !vm.prompt || !vm.current ? (
            <p className="flex flex-1 items-center justify-center text-[14px] text-ops-sub">
              불러오는 중…
            </p>
          ) : (
            <Prompt vm={vm} />
          )}
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

// 머리 줄 — 1줄 이름 · 배지 / 2줄 목소리 · 저장 시각 | 오른쪽 버튼
// 연필(3단계) · 목소리 드롭다운(2단계) · 수정 기록 보기(5단계)는 그 단계에서
function Prompt({ vm }: { vm: Vm }) {
  const p = vm.prompt!
  const c = vm.current!
  const navigate = useNavigate()
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-ops-line bg-white">
      <header className="flex flex-wrap items-center gap-4 border-b border-ops-line px-7 py-5">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[22px] font-bold">{c.name}</h2>
            {/* 지난 버전을 볼 땐 그 버전의 배지, 아니면 상담가의 배지 */}
            {p.past ? (
              p.badges.map((b) => (
                <Badge key={b.label} tone={b.tone}>
                  {b.label}
                </Badge>
              ))
            ) : (
              <>
                {c.inUse && <Badge tone="done">통화에 사용 중</Badge>}
                {c.applying && <Badge tone="wait">{c.applying}</Badge>}
              </>
            )}
          </div>
          <p className="flex flex-wrap items-center gap-4 text-[14px] text-ops-sub">
            <span>목소리 {c.voice}</span>
            <span>
              {p.time} 저장{p.author && ` · ${p.author}`}
            </span>
            {p.past && (
              // 시나리오 시험에서 지난 버전으로 돌아왔을 때만 — 기록 창(5단계) 전까지 빠져나갈 길
              <button type="button" className="underline" onClick={vm.closeHistory}>
                지난 버전 보는 중 · 현재 버전 보기
              </button>
            )}
          </p>
        </div>
        <span className="ml-auto flex flex-wrap gap-2">
          {p.reuse && (
            <Btn kind="edit" disabled={p.reuse.disabled} title={p.reuse.hint} onClick={vm.askReuse}>
              이 버전 다시 쓰기
            </Btn>
          )}
          {c.deletable && (
            <Btn kind="danger" onClick={() => vm.askDelete(c.personaSeq)}>
              삭제
            </Btn>
          )}
          {p.canEdit && (
            // 2단계(그 자리에서 고치기) 전까지 임시
            <Btn kind="edit" onClick={vm.startEdit}>
              프롬프트 수정
            </Btn>
          )}
          {vm.testTo && (
            <Btn kind="plain" onClick={() => void navigate(vm.testTo!)}>
              시나리오 시험
            </Btn>
          )}
          {c.canUse && (
            <Btn kind="line" onClick={() => vm.askUse(c.personaSeq)}>
              통화에 사용하기
            </Btn>
          )}
          {vm.canApply && (
            // 4단계 반영 전 띠 전까지 임시
            <Btn kind="line" onClick={vm.applyHead}>
              통화에 반영
            </Btn>
          )}
        </span>
      </header>
      <PromptBody p={p} />
    </article>
  )
}

// 프롬프트 — 회색 제목 줄 + 본문(글 그대로)을 한 테두리 안에 (11/13 새 안: 입력 칸과 같은 모양이라 마크다운으로 꾸미지 않음)
function PromptBody({ p }: { p: NonNullable<Vm['prompt']> }) {
  return (
    <div className="min-h-0 flex-1 [scrollbar-width:thin] overflow-y-auto px-8 py-6">
      <h3 className="mb-2 text-[17px] font-bold">프롬프트</h3>
      <div className="overflow-hidden rounded-md border border-ops-line">
        {p.sections.map((s) => (
          <section key={s.key} className="border-b border-ops-line last:border-b-0">
            <h4 className="border-b border-ops-line bg-ops-paper px-3 py-1.5 text-[13px] font-bold text-ops-sub">
              {s.title}
            </h4>
            <p className="px-3 py-3 text-[14px] leading-6 whitespace-pre-wrap">
              {s.rows
                ? // 지난 버전: 바로 직전 버전 기준 빠진 말 = 파란 취소선, 더한 말 = 파란 강조
                  s.rows.map((r) => (
                    <span key={r.key} className="block">
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
                    </span>
                  ))
                : s.text}
            </p>
          </section>
        ))}
      </div>
    </div>
  )
}
