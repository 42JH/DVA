// 06 통화 상세 Model — API-22 상세 · API-23 대화 · API-25 처리 결과 · API-24 AI 동작 (연동 상세명세 10/31 §5.2). React를 모르는 데이터 층
// 네 요청은 따로 받음(11/02 '통화 내역 자동 갱신' 연동 명세): 한 영역이 늦거나 실패해도 나머지는 먼저 그림. 합치는 건 훅이 toCallDetail로
// 열어 둔 동안 5초마다 다시 받아 늦게 온 분석 · 발화 · 동작 · 처리 내역 · 녹취를 같은 통화에 붙임. 숨긴 탭에선 멈추고 다시 보이면 바로 받음(React Query 기본)
// 개발 중엔 MSW 가짜(mocks/handlers/calls.ts)가 같은 모양으로 응답 — 늦게 오는 · 실패하는 시나리오도 거기
import { queryOptions } from '@tanstack/react-query'
import { api, ApiError, type ApiItem } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import type { CallActionDto, CallDetailDto, CallProcessingResultDto, UtteranceDto } from './callDto'

export { toCallDetail } from './callDto'
export type { AiAction, CallDetail, Complaint, Recording, ResultBlock, Utterance } from './callDto'

/** 열어 둔 통화 상세를 다시 받는 주기 (명세 권장 5초) */
export const CALL_REFRESH_MS = 5_000
/** 404(통화 없음)면 그 조회의 반복을 멈춤 (명세: 통화 상세 404는 통화 없음 처리 후 반복 중단)
 * 반복은 통화 상세(useCallDetail)에서만 걸음 — 같은 통화를 읽는 다른 곳(옆 창 대화 기록 등)은 반복하지 않음 (11/09 검수) */
export const poll = (q: { state: { error: unknown } }) =>
  q.state.error instanceof ApiError && q.state.error.status === 404 ? false : CALL_REFRESH_MS

export const callQueries = {
  all: () => ['calls'] as const,
  /** 기본 정보 · 분석 · 녹취 (녹취 URL은 조회마다 바뀌지만 재생 훅이 같은 녹취면 소리를 안 바꿈) */
  detail: (id: number) =>
    queryOptions({
      queryKey: [...callQueries.all(), id],
      queryFn: async ({ signal }) =>
        (await api.get<ApiItem<CallDetailDto>>(`/calls/${id}`, { signal })).data,
    }),
  // 아래 셋은 처음 100개가 전부라는 보장이 없어 끝까지 받음(fetchAll)
  transcript: (id: number) =>
    queryOptions({
      queryKey: [...callQueries.all(), id, 'transcript'],
      queryFn: ({ signal }) => fetchAll<UtteranceDto>(`/calls/${id}/transcript`, {}, signal),
    }),
  results: (id: number) =>
    queryOptions({
      queryKey: [...callQueries.all(), id, 'results'],
      queryFn: ({ signal }) =>
        fetchAll<CallProcessingResultDto>(`/calls/${id}/processing-results`, {}, signal),
    }),
  actions: (id: number) =>
    queryOptions({
      queryKey: [...callQueries.all(), id, 'actions'],
      queryFn: ({ signal }) => fetchAll<CallActionDto>(`/calls/${id}/actions`, {}, signal),
    }),
}
