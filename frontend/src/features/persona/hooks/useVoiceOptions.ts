import { useQuery } from '@tanstack/react-query'
import type { Option } from '@/shared/ui'
import { personaQueries, type VoiceSettings } from '@/features/persona/api/personaApi'
import { DEFAULT_VOICE_LABEL, SPEED_CHOICE, WAIT_CHOICE } from '@/features/persona/labels'

type Speed = VoiceSettings['speed']
type WaitTime = VoiceSettings['waitTime']
const SPEEDS: Speed[] = ['SLOW', 'NORMAL', 'FAST']
const WAITS: WaitTime[] = ['SHORT', 'NORMAL', 'LONG']
const NO_AI = 'AI 미지원'

/** 음성 고르기 칸의 선택지. 수정 · 추가 창 공용 — AI가 실제 지원하는 값은 GET /api/ai/options (11/02)
 * 목소리 = AI 목록 — 지금 값이 목록에 없어도(AI가 바뀜) 선택지에 남김
 * 속도 · 기다리기 = 늘 세 칸, AI가 지원 안 하는 칸은 꺼 두고 'AI 미지원' (11/02 사용자). 지금 값은 끄지 않음(이미 저장된 버전을 그대로 보이게)
 * 그래도 서버가 422로 거절하면 화면에 어느 칸인지 안내 (labels unsupportedText) */
export function useVoiceOptions() {
  const q = useQuery(personaQueries.options())
  const data = q.data
  const keep = <T extends string>(list: Option<T>[], cur: T, label: string): Option<T>[] =>
    list.some((o) => o.value === cur) ? list : [...list, { value: cur, label }]
  return {
    isPending: q.isPending,
    rateRange: data?.rateRange ?? null,
    voiceOptions: (cur: string) =>
      keep(
        [
          { value: '', label: DEFAULT_VOICE_LABEL },
          ...(data?.voices ?? []).map((v) => ({ value: v.id, label: v.label })),
        ],
        cur,
        cur,
      ),
    // 불러오기 전엔 끄지 않음 (깜빡임 방지 — 저장 버튼은 불러올 때까지 꺼져 있음)
    speedOptions: (cur: Speed) =>
      SPEEDS.map((k) => ({
        value: k,
        label: SPEED_CHOICE[k],
        ...(data && !data.rateRange && k !== 'NORMAL' && k !== cur && { disabledHint: NO_AI }),
      })),
    waitOptions: (cur: WaitTime) =>
      WAITS.map((k) => ({
        value: k,
        label: WAIT_CHOICE[k],
        ...(data && !data.waitTimes.includes(k) && k !== cur && { disabledHint: NO_AI }),
      })),
  }
}
