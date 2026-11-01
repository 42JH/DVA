import { useQuery } from '@tanstack/react-query'
import type { Option } from '@/shared/ui'
import { personaQueries, type VoiceSettings } from '@/features/persona/api/personaApi'
import { DEFAULT_VOICE_LABEL, SPEED_CHOICE, WAIT_CHOICE } from '@/features/persona/labels'

type Speed = VoiceSettings['speed']
type WaitTime = VoiceSettings['waitTime']

/** 음성 고르기 칸의 선택지 — AI가 실제 지원하는 값(GET /api/ai/options, 11/02). 수정 · 추가 창 공용
 * 지금 값이 목록에 없어도(AI가 바뀜) 선택지에 남겨 화면이 비지 않게 함. 숫자 속도 미지원이면 속도는 '보통'만 */
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
    speedOptions: (cur: Speed) =>
      keep(
        (data?.rateRange ? (['SLOW', 'NORMAL', 'FAST'] as Speed[]) : (['NORMAL'] as Speed[])).map(
          (k) => ({ value: k, label: SPEED_CHOICE[k] }),
        ),
        cur,
        SPEED_CHOICE[cur],
      ),
    waitOptions: (cur: WaitTime) =>
      keep(
        (data?.waitTimes ?? (['NORMAL'] as WaitTime[])).map((k) => ({
          value: k,
          label: WAIT_CHOICE[k],
        })),
        cur,
        WAIT_CHOICE[cur],
      ),
  }
}
