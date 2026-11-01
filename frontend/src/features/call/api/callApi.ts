// 06 통화 상세 Model — API-22 상세 + API-23 대화 · API-25 처리 결과 · API-24 AI 동작 (연동 상세명세 10/31 §5.2). React를 모르는 데이터 층
// 네 요청을 한 번에 받아 화면 모양 하나(CallDetail)로 — 변환은 callDto.ts. '주문 보기'의 주문은 shared/order
// 개발 중엔 MSW 가짜(mocks/handlers/calls.ts)가 같은 모양으로 응답
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import {
  toCallDetail,
  type CallActionDto,
  type CallDetail,
  type CallDetailDto,
  type CallProcessingResultDto,
  type UtteranceDto,
} from './callDto'

export type {
  AiAction,
  CallDetail,
  Complaint,
  Outcome,
  Recording,
  ResultBlock,
  Utterance,
} from './callDto'

export const callQueries = {
  all: () => ['calls'] as const,
  detail: (id: number) =>
    queryOptions({
      queryKey: [...callQueries.all(), id],
      queryFn: ({ signal }) => fetchCallDetail(id, signal),
      // 녹취 URL이 창을 오갈 때마다 바뀌면 듣던 중에 끊김 → 만료(5분)되면 재생 훅이 직접 refetch
      staleTime: Infinity,
    }),
}

export async function fetchCallDetail(id: number, signal?: AbortSignal): Promise<CallDetail> {
  const [detail, utterances, results, actions] = await Promise.all([
    api.get<ApiItem<CallDetailDto>>(`/calls/${id}`, { signal }),
    fetchAll<UtteranceDto>(`/calls/${id}/transcript`, {}, signal), // 처음 100개가 전부라는 보장이 없어 끝까지
    fetchAll<CallProcessingResultDto>(`/calls/${id}/processing-results`, {}, signal),
    fetchAll<CallActionDto>(`/calls/${id}/actions`, {}, signal),
  ])
  return toCallDetail(detail.data, utterances, results, actions)
}
