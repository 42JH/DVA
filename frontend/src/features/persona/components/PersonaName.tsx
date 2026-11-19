import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { useRenamePersona } from '@/features/persona/hooks/useRenamePersona'
import { Icon } from '@/shared/ui'

// 머리 줄 이름 + 연필 (새 안 10번, 피그마 2384:2) — 누르면 이름 자리만 입력 칸
// Enter = 저장, Esc · 칸 밖 = 원래 이름. target이 null이면 연필 없음 (권한 없음 · 지난 버전 · 프롬프트 고치는 중)
// locked: 시험 · 반영 중 — 연필은 그대로 보이되 못 누름 (피그마 2368:3212)
// applyAfter: 이름을 저장하면 바로 통화에 반영 (통화에 쓰는 상담가 · 반영 전 내용 없음 — useRenamePersona)
export function PersonaName({
  name,
  target,
  locked = false,
  applyAfter = false,
}: {
  name: string
  target: EditTarget | null
  locked?: boolean
  applyAfter?: boolean
}) {
  const r = useRenamePersona(target, applyAfter)
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
            className="grid size-8 place-items-center rounded-md text-ops-faint outline-none focus-visible:ring-2 focus-visible:ring-ops-route enabled:hover:text-ops-ink"
          >
            <Icon name="pen" />
          </button>
        )}
      </span>
    )
  return (
    // 키 · 칸 밖은 감싼 곳에서 받음 (React의 onBlur는 안쪽 입력 칸에서 올라옴)
    // 칸은 시안 크기(280 × 40, 글씨 20)이고 위아래를 4씩 당겨 머리 줄이 밀리지 않게 함. 오류 글은 칸 아래에 띄움
    <span
      className="relative flex"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) r.submit() // 한글 조합 중 Enter는 글자 확정
        if (e.key === 'Escape') r.stop()
      }}
      onBlur={r.stop}
    >
      {/* 이름을 고치는 동안에도 제목 순서(h1 → h2 → h3 프롬프트)가 이어지게 — 화면엔 입력 칸만 보임 */}
      <h2 className="sr-only">{name}</h2>
      <input
        aria-label="상담가 이름"
        value={r.draft}
        onChange={(e) => r.setDraft(e.target.value)}
        readOnly={r.pending}
        autoFocus
        className={`-my-1 h-10 w-[280px] max-w-full rounded-md border bg-white px-3 text-[20px] font-bold outline-none ${r.error ? 'border-ops-stop shadow-[0_0_0_3px_var(--color-ops-stop-soft)]' : 'border-ops-route shadow-[0_0_0_3px_var(--color-ops-route-soft)]'}`}
      />
      {r.error && (
        <span
          role="alert"
          className="absolute top-full left-0 mt-2 text-[12px] whitespace-nowrap text-ops-stop"
        >
          {r.error}
        </span>
      )}
    </span>
  )
}
