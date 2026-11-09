// 미답변 질문이 나온 통화 안 시각(초) — 그 통화의 처리 결과(AI가 답하지 못한 질문)에 있음
import { useQuery } from '@tanstack/react-query'
import { callQueries } from '@/shared/call/callApi'

// ready = 처리 결과를 받았나 (받은 뒤 그려야 질문한 말로 바로 스크롤됨)
export function useQuestionAt(callSeq: number, unansweredSeq: number) {
  const results = useQuery({ ...callQueries.results(callSeq), staleTime: 30_000 })
  const sec =
    results.data?.find((r) => r.unansweredQuestionSeq === unansweredSeq)?.offsetSeconds ?? null
  return { sec, ready: !results.isPending }
}
