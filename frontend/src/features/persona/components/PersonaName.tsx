import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { useRenamePersona } from '@/features/persona/hooks/useRenamePersona'
import { Icon } from '@/shared/ui'

// 머리 줄 이름 + 연필 (11/13 새 안 10번, 피그마 2384:2) — 누르면 이름 자리만 입력 칸
// Enter = 저장, Esc · 칸 밖 = 원래 이름. target이 null이면 연필 없음 (권한 없음 · 지난 버전 · 프롬프트 고치는 중)
// locked: 시험 · 반영 중 — 연필은 보이되 흐리고 못 누름 (피그마 2368:3212)
export function PersonaName({
  name,
  target,
  locked = false,
}: {
  name: string
  target: EditTarget | null
  locked?: boolean
}) {
  const r = useRenamePersona(target)
  if (!r.renaming)
    return (
      <span className="flex items-center gap-1">
        <h2 className="text-[22px] font-bold">{name}</h2>
        {(r.canRename || locked) && (
          <button
            type="button"
            aria-label="이름 바꾸기"
            disabled={locked}
            onClick={r.start}
            className="rounded p-1 text-ops-sub outline-none hover:text-ops-ink focus-visible:ring-2 focus-visible:ring-ops-route disabled:text-ops-faint"
          >
            <Icon name="pen" />
          </button>
        )}
      </span>
    )
  return (
    // 키 · 칸 밖은 감싼 곳에서 받음 (React의 onBlur는 안쪽 입력 칸에서 올라옴)
    // 칸은 이름과 같은 글씨 · 줄 높이, 테두리는 ring이라 머리 줄이 밀리지 않음. 오류 글은 칸 아래에 띄움
    <span
      className="relative flex"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) r.submit() // 한글 조합 중 Enter는 글자 확정
        if (e.key === 'Escape') r.stop()
      }}
      onBlur={r.stop}
    >
      <input
        aria-label="상담가 이름"
        value={r.draft}
        onChange={(e) => r.setDraft(e.target.value)}
        readOnly={r.pending}
        autoFocus
        className={`-ml-2 field-sizing-content max-w-96 min-w-40 rounded-md bg-white px-2 text-[22px] font-bold ring-1 outline-none ${r.error ? 'ring-ops-stop' : 'ring-ops-route'}`}
      />
      {r.error && (
        <span
          role="alert"
          className="absolute top-full left-0 mt-1 text-[12px] whitespace-nowrap text-ops-stop"
        >
          {r.error}
        </span>
      )}
    </span>
  )
}
