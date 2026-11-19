import { useQuery } from '@tanstack/react-query'
import type { Option } from '@/shared/ui'
import { personaQueries } from '../api/personaApi'
import { DEFAULT_VOICE_LABEL } from '../labels'

/** 음성 고르기 칸의 선택지. 수정 · 추가 화면 공용 — AI가 실제 지원하는 값은 GET /api/ai/options
 * 목소리 = AI 목록 — 지금 값이 목록에 없어도(AI가 바뀜) 선택지에 남김
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
  }
}
