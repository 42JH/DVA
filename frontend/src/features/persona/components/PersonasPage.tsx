// AI 상담가 (11/13 새 안, 피그마 2368:2525) — 위 탭으로 상담가 고르기 | 카드 = 머리 줄(이름 · 목소리 · 저장 시각 · 버튼) + 프롬프트
// 11/11: 저장 = 새 버전, [적용] 없음. 버전 기록은 5단계 수정 기록 창으로 옮김
// 데이터 · 규칙은 usePersonaPage. 카드 = 탭 + 그 자리에서 고치기 (PersonaCard). [시나리오 시험]은 따로 화면 (ScenarioTest)
import { useLocation } from 'react-router'
import { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { AddPersona } from './AddPersona'
import { PersonaCard } from './PersonaCard'
import { PageHead } from '@/shared/ui'
import { Confirm } from '@/shared/ui/Modal'

// 사이드바의 [AI 상담가]를 다시 눌러도 location.key가 새로 생김 → 화면 상태를 통째로 버리고 처음(상담가 유형 탭)으로.
// 고치는 중이면 PersonaCard의 useLeaveGuard가 그 이동을 먼저 막아 확인을 물음
export function PersonasPage() {
  return <PersonasView key={useLocation().key} />
}

// 시안: 위 16 · 옆 24 · 아래 24, 탭 줄과 카드 사이 16
const FRAME = 'flex min-h-0 flex-1 flex-col gap-4 px-6 pt-4 pb-6'

function PersonasView() {
  const vm = usePersonaPage()
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
        // 등록 — 위 탭 아래 '새 상담가' 카드. 목록이 비어 있어도 첫 상담가를 만들 수 있게 맨 앞에서 가름
        <div className={FRAME}>
          <AddPersona vm={vm} />
        </div>
      ) : vm.error || vm.isLoading || vm.personas.length === 0 ? (
        <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
          {vm.error ?? (vm.isLoading ? '불러오는 중…' : '상담가가 없습니다.')}
        </p>
      ) : (
        <div className={FRAME}>
          <PersonaCard vm={vm} />
        </div>
      )}
      {vm.confirm && (
        <Confirm
          title={vm.confirm.title}
          ok={vm.confirm.okLabel}
          danger={vm.confirm.danger}
          busy={vm.confirmBusy}
          error={vm.confirmError}
          onOk={vm.confirmOk}
          onClose={vm.confirmCancel}
        >
          {vm.confirm.failed && <p>실패: {vm.confirm.failed.join(', ')}</p>}
          {vm.confirm.note}
        </Confirm>
      )}
    </>
  )
}
