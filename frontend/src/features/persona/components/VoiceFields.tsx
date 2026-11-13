import { Icon } from '@/shared/ui'
import { Label } from '@/shared/ui/Field'
import type { useVoiceDraft } from '@/features/persona/hooks/useVoiceDraft'

// 카드 머리 줄의 목소리 칸 모양 (시안: 높이 28 · 테두리 #c5ccd6 · 옆 10) — 고를 수 있을 때(VoiceFields)와 못 고를 때(PersonaCard)가 같이 씀
export const VOICE_BOX =
  'relative flex h-7 items-center gap-1.5 rounded-md border border-[#c5ccd6] px-2.5 text-[13px] text-ops-sub'

// 07 목소리 드롭다운 — 고르는 즉시 작성 중 값에 반영 → 화면 [저장] · [등록]으로 같이 저장 (11/11)
// 카드 머리 줄: 테두리 안에 '목소리 기본 음성 ⌄' 작은 칸 (11/13 새 안 7번) | form: 등록 화면 이름 옆 칸 (TextInput과 같은 모양)
// 기본 음성 값이 ''라 '선택' 같은 빈 선택지는 두지 않음 (두면 기본 음성이 '선택'으로 보임)
export function VoiceFields({
  vm,
  form,
}: {
  vm: ReturnType<typeof useVoiceDraft>
  form?: boolean
}) {
  const select = (
    <select
      value={vm.voice.voice}
      onChange={(e) => vm.setVoiceName(e.target.value)}
      aria-label={form ? undefined : '목소리'}
      className={`appearance-none bg-transparent text-ops-ink outline-none ${form ? 'h-9 w-full rounded-md bg-white! pr-9 pl-3 text-[14px] ring-1 ring-ops-line ring-inset focus:ring-ops-route' : 'pr-5 text-[13px] font-semibold'}`}
    >
      {vm.voiceOptions.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
  const chevron = (
    <Icon
      name="chevron"
      className={`pointer-events-none absolute top-1/2 size-3.5 -translate-y-1/2 text-ops-sub ${form ? 'right-3' : 'right-2.5'}`}
    />
  )
  return form ? (
    <label className="flex min-w-0 flex-col gap-1">
      <Label>목소리</Label>
      <span className="relative">
        {select}
        {chevron}
      </span>
    </label>
  ) : (
    <span className={`${VOICE_BOX} bg-white focus-within:border-ops-route`}>
      목소리
      {select}
      {chevron}
    </span>
  )
}
