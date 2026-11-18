import { useQuery } from '@tanstack/react-query'
import { personaQueries } from '@/features/persona/api/personaApi'

/** 지금 통화에 쓰는 페르소나 이름 — 상단바 '빠른 접수형 AI 상담가' (서비스 전체에 하나). 없거나 못 받으면 null → 상단바가 상태를 안 그림 */
export function useActivePersonaName() {
  return useQuery(personaQueries.list()).data?.find((p) => p.inUse)?.name ?? null
}
