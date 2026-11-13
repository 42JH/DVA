import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { useRenamePersona } from '@/features/persona/hooks/useRenamePersona'
import { Icon } from '@/shared/ui'
import { Err, TextInput } from '@/shared/ui/Field'

// 머리 줄 이름 + 연필 (11/13 새 안 10번, 피그마 2384:2) — 누르면 이름 자리만 입력 칸
// Enter = 저장, Esc · 칸 밖 = 원래 이름. target이 null이면 연필 없음 (권한 없음 · 지난 버전 · 프롬프트 고치는 중)
export function PersonaName({ name, target }: { name: string; target: EditTarget | null }) {
  const r = useRenamePersona(target)
  if (!r.renaming)
    return (
      <span className="flex items-center gap-1">
        <h2 className="text-[22px] font-bold">{name}</h2>
        {r.canRename && (
          <button
            type="button"
            aria-label="이름 바꾸기"
            onClick={r.start}
            className="rounded p-1 text-ops-sub outline-none hover:text-ops-ink focus-visible:ring-2 focus-visible:ring-ops-route"
          >
            <Icon name="pen" />
          </button>
        )}
      </span>
    )
  return (
    // 키 · 칸 밖은 감싼 곳에서 받음 (React의 onBlur는 안쪽 입력 칸에서 올라옴)
    <div
      className="flex w-72 flex-col gap-1"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) r.submit() // 한글 조합 중 Enter는 글자 확정
        if (e.key === 'Escape') r.stop()
      }}
      onBlur={r.stop}
    >
      <TextInput
        label="상담가 이름"
        labelClassName="sr-only"
        value={r.draft}
        onChange={r.setDraft}
        readOnly={r.pending}
        autoFocus
      />
      {r.error && <Err>{r.error}</Err>}
    </div>
  )
}
