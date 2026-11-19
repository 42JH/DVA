import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { fmtClock } from '@/shared/lib/format'
import { callQueries, poll, type Complaint, toCallDetail } from '@/shared/call/callApi'
import { utteranceForAction } from '@/shared/call/callDto'
import { useRecordingPlayer } from '@/shared/call/useRecordingPlayer'
import {
  actionViews,
  emptyText,
  faqResultTimes,
  focusOf,
  marksOf,
  recordingNote,
  toSegments,
  withLead,
  type Timed,
} from './callScript'

/** 06 통화 상세 훅 (새 디자인) — 대본(불만 묶음) · 녹취 재생(이전 · 다음 발화 · 음량) · AI 동작(짚은 말과 같이 하이라이트)
 * 네 조회(기본 · 대화 · 처리 결과 · AI 동작)를 따로 받아 5초마다 다시 — 늦게 온 분석 · 발화 · 녹취가 같은 화면에 붙고, 한 영역이 늦거나 실패해도 나머지는 그대로 (연동 명세) */
export function useCallDetail(callId: number, fromFaq?: number) {
  // AI 동작을 눌러 짚은 통화 안 시각(초)과, 스크립트가 그 줄로 스크롤할 신호 (누를 때마다 n이 늘어 같은 줄도 다시 스크롤)
  const [cursor, setCursor] = useState<number | null>(null)
  const [jump, setJump] = useState<{ key: number; n: number } | null>(null)
  // 고른 줄 (누름 · ⏮ ⏭ · AI 동작) — 시각이 같은 줄이 여럿이면 시각만으로는 앞 줄을 못 고름(뒤 줄이 이김) → 고른 줄을 다음 줄 시작 전까지 붙잡음
  const [pin, setPin] = useState<{ key: number; sec: number } | null>(null)

  // 끝나고 분석까지 끝났고 녹취도 왔으면 더 올 게 없음 → 5초 반복을 멈춤 (다 끝난 통화를 열어 두면 네 요청을 계속 보냄)
  // 창을 다시 보면 한 번 받는 건 그대로(React Query 기본)
  const [settled, setSettled] = useState(false)
  const every = settled ? false : poll
  const detail = useQuery({ ...callQueries.detail(callId), refetchInterval: every })
  const transcript = useQuery({ ...callQueries.transcript(callId), refetchInterval: every })
  const resultsQ = useQuery({ ...callQueries.results(callId), refetchInterval: every })
  const actionsQ = useQuery({ ...callQueries.actions(callId), refetchInterval: every })
  const d = detail.data
  const done = !!d?.call.endedAt && d.call.analysisStatus !== 'PENDING' && d.recordings.length > 0
  if (done !== settled) setSettled(done)
  // 기본 정보가 오면 바로 그림. 나머지는 받은 만큼 (아직 못 받은 영역은 빈 칸 + 그 영역 문구)
  const call = detail.data
    ? toCallDetail(detail.data, transcript.data ?? [], resultsQ.data ?? [], actionsQ.data ?? [])
    : undefined
  const player = useRecordingPlayer(call?.recording ?? null, () => {
    void detail.refetch()
  })
  const says = withLead(call?.utterances ?? []) // 듣기 시각이 보정된 말들 (아래 전부 이걸 씀)
  // 녹취는 통화 시작보다 늦게 시작함 — 발화 시각(통화 시작부터)과 녹취 위치가 그만큼 어긋나 줄을 누르면 그 말을 놓침
  // 실서버 #596 · #590: 빈 칸이 녹취 앞쪽에 있고 크기 = 통화 길이 − 녹취 길이(2.2초 · 1.8초). 녹취 위치 = 통화 시각 − shift
  const shift =
    player.length && call?.durationSec ? Math.max(0, call.durationSec - player.length) : 0
  const callNow = player.now > 0 ? player.now + shift : 0 // 재생 위치를 통화 시각으로
  const seekCall = (sec: number) => player.seek(Math.max(0, sec - shift))
  // 지금 짚은 줄: 녹취가 돌면 재생 위치, 아니면 누른 시각 (AI 동작을 누르면 왼쪽 그 부분 + 그 부분 음성)
  const at = callNow > 0 ? callNow : cursor
  const focusKey = focusOf(says, at, pin)
  // AI 동작을 누르면 그 동작을 부른 '고객의 말'로 — AI 말이 아니라. 고객 말 처음부터 듣게 그 말의 시각으로 감
  const jumpTo = (sec: number, text: string) => {
    const line = utteranceForAction(says, sec, text)
    const at = line?.atSec ?? sec
    setCursor(at)
    setPin(line ? { key: line.order, sec: at } : null)
    if (line) setJump((j) => ({ key: line.order, n: (j?.n ?? 0) + 1 }))
    seekCall(at)
  }
  /** 그 줄부터 듣기 (스크립트 줄을 누름 · ⏮ ⏭) — 스크롤은 부른 쪽이 */
  const listenFrom = (key: number, sec: number) => {
    setCursor(sec)
    setPin({ key, sec })
    seekCall(sec)
  }

  // 404는 받은 게 있어도 '통화 없음'(삭제된 통화 — 반복 조회도 멈춤). 그 밖의 오류 화면은 아무것도 못 받았을 때만,
  // 받은 게 있으면 그대로 두고(재조회 실패 · 일부만 수신) 안내 한 줄 (연동 명세)
  // FAQ 상세 고객 질문 사례에서 왔는데 통화가 지워졌으면(404) 그 FAQ 상세를 다시 받아 링크를 갱신 (명세)
  const qc = useQueryClient()
  const gone = detail.error instanceof ApiError && detail.error.status === 404
  useEffect(() => {
    if (gone && fromFaq) void qc.invalidateQueries({ queryKey: ['faqs', 'detail', fromFaq] })
  }, [gone, fromFaq, qc])

  let error: string | null = null
  if (gone)
    error = '통화 원본이 삭제되어 조회할 수 없습니다.' // FAQ 상세 사례 · 다른 화면에서 온 지워진 통화 (FAQ 사례 연동 문구)
  else if (!call && detail.error) error = '불러오지 못했습니다. 다시 시도해 주세요.'
  // 이미 받은 영역의 재조회가 실패하면 받은 내용은 그대로 두고 한 줄 알림 (다음 갱신에서 다시)
  const notice =
    call && [detail, transcript, resultsQ, actionsQ].some((q) => q.isError && q.data !== undefined)
      ? '다시 받지 못한 부분이 있어요. 마지막으로 받은 내용을 보여 드려요.'
      : null
  const recordingText = recordingNote(call?.recording ?? null, player.state === 'failed')

  // 이전 · 다음 발화 (새 디자인 재생 줄 ⏮ ⏭) — 지금 짚은 말 기준. 짚은 말이 없으면 다음 = 첫 말
  const timed = says.filter((u): u is Timed & { atSec: number } => u.atSec !== null)
  const here = focusKey === null ? -1 : timed.findIndex((u) => u.order === focusKey)
  const goLine = (u: (typeof timed)[number] | undefined) => {
    if (!u) return
    setJump((j) => ({ key: u.order, n: (j?.n ?? 0) + 1 }))
    listenFrom(u.order, u.atSec)
  }
  /** 판정 한 건의 첫 말로 (오른쪽 시각 · 재생 바 눈금) — 그 말이 없으면 판정 시각의 말 */
  const goComplaint = (c: Complaint) => {
    const sec = c.offsetSeconds
    goLine(
      timed.find((u) => c.utteranceOrders.includes(u.order)) ??
        (sec === null ? undefined : timed.findLast((u) => u.atSec <= sec)),
    )
  }
  const lengthSec = player.length || call?.durationSec || 0

  return {
    isLoading: detail.isPending,
    error,
    notice,

    // 대본 + 녹취 재생 (아래 재생 줄)
    player: {
      state: player.state,
      playing: player.playing,
      now: fmtClock(Math.floor(callNow)), // 대화 줄 시각과 같은 통화 시각
      length: fmtClock(Math.floor(lengthSec + shift)),
      progress: player.progress,
      toggle: player.toggle,
      scrub: player.scrub, // 진행 바 드래그
      prev: () => goLine(here > 0 ? timed[here - 1] : timed[0]),
      next: () => goLine(timed[here + 1]),
      volume: player.volume,
      muted: player.muted,
      setVolume: player.setVolume,
      toggleMute: player.toggleMute,
      src: player.src,
      handlers: player.handlers,
      text: recordingText, // 녹취가 없거나 못 들을 때 한 줄
      marks: marksOf(call?.complaints ?? [], says, { shift, lengthSec, go: goComplaint }),
    },
    goComplaint,
    audioRef: player.audioRef, // <audio>에 꽂을 ref — player와 따로 넘김 (렌더 중 ref 접근 규칙)
    // 대본 줄을 누르면 그 말부터 듣기 — 시각을 아는 줄만
    segments: call
      ? toSegments(says, call.complaints).map((seg) => ({
          ...seg,
          lines: seg.lines.map((l) => {
            const sec = l.atSec
            return sec === null ? l : { ...l, onClick: () => listenFrom(l.key, sec) }
          }),
        }))
      : [],
    scriptEmpty: emptyText(
      transcript,
      '대화를 불러오는 중…',
      '대화를 받지 못했어요. 잠시 뒤 다시 받아요.',
      '발화가 없습니다.',
    ),
    focusKey, // 하이라이트하는 줄 (발화 순번)
    jump, // 그 줄로 스크롤 (AI 동작 · 이전 · 다음을 눌렀을 때만 — 재생 중엔 하이라이트만 따라가고 스크롤은 안 함)

    actions: actionViews(call?.actions ?? [], says, {
      faqResultAt: faqResultTimes(call?.results ?? []),
      focusKey,
      jumpTo,
    }),
  }
}
