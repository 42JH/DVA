import type { usePersonaPage } from '@/features/persona/hooks/usePersonaPage'
import { Badge, Btn, Icon, Segments } from '@/shared/ui'

type Vm = ReturnType<typeof usePersonaPage>

// 위 탭 + [상담가 등록] — 보기 · 등록 화면 공용 (새 안 7번: 등록 중에도 탭이 보이고 고른 탭은 없음)
// go: 고친 게 있으면 먼저 물은 뒤 이동 (useLeaveGuard.leave)
export function PersonaTabs({
  vm,
  adding,
  go,
}: {
  vm: Vm
  adding: boolean
  go: (next: () => void) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Segments
        label="상담가"
        value={adding ? '' : String(vm.current?.personaSeq ?? '')}
        items={vm.personas.map((p) => ({
          value: String(p.personaSeq),
          label: p.name,
          badge: p.inUse && <Badge tone="done">사용 중</Badge>,
        }))}
        onPick={(v) =>
          go(() => {
            vm.closeAdd()
            vm.selectPersona(Number(v))
          })
        }
      />
      {vm.canAdd && (
        // 등록 중이면 이미 그 화면 — 누르지 않아도 됨. 오른쪽 끝은 카드 안 버튼 줄(카드 여백 28)에 맞춤 (시안)
        <Btn kind="line" className="mr-7 ml-auto" disabled={adding} onClick={() => go(vm.openAdd)}>
          <Icon name="plus" />
          상담가 등록
        </Btn>
      )}
    </div>
  )
}
