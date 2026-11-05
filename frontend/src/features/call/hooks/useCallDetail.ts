import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '@/shared/api/client'
import { fmtClock, fmtDetailTime, fmtDuration, fmtPhone } from '@/shared/lib/format'
import { reasonTag, unansweredTo } from '@/shared/lib/unansweredReason'
import { ACTION_LABEL, COMPLAINT_LABEL, RESULT_LABEL } from '@/features/call/labels'
import {
  callQueries,
  type Complaint,
  type ResultBlock,
  toCallDetail,
  type Utterance,
} from '@/features/call/api/callApi'
import { utteranceAt, utteranceForAction } from '@/features/call/api/callDto'
import { kindChips } from './useCallList'
import { useRecordingPlayer } from './useRecordingPlayer'

/** 스크립트 한 줄 (말만 — AI 동작은 오른쪽 처리 내용으로, 10/30). onClick = 이 말부터 듣기 (11/01, 시각을 모르면 없음) */
export interface ScriptLine {
  key: number // 발화 순번 (= 서버 order)
  atSec: number | null
  time: string // '00:31' (위치를 모르면 '')
  who: 'AI' | '고객'
  text: string
  onClick?: () => void
}
/** 연속 구간: 불만이면 빨간 묶음으로 */
export interface ScriptSegment {
  complaint: { label: string } | null
  lines: ScriptLine[]
}

/** 처리 내용 블록 한 개 */
export interface ResultView {
  key: string
  label: string // '접수' · '주문 취소' · 'AI 미답변' · '상담원 이관 요청'
  time: string
  link?: { label: string; onClick: () => void }
  question?: string // AI 미답변: 고객 질문
  reason?: ReturnType<typeof reasonTag> // AI 미답변: 사유 태그 (유사한 질문 없음 · 서버 에러)
}

/** AI 동작 기록 한 줄. onClick = 그 동작을 부른 고객 말로 스크립트를 넘기고 녹취를 그 말부터 재생 (시각을 모르면 없음) */
export interface ActionView {
  key: number
  time: string
  tag: string // 저장 · 검색 · 조회 · 취소 · 전송
  text: string
  onClick?: () => void
}

/** 고객 말의 서버 시각(offsetSeconds)은 음성 인식이 끝난 뒤 찍혀서 실제 말보다 늦음 — 빨리 말하면 그 말을 놓침 (11/01 사용자, 실서버 녹취)
 *  → 듣기 · 강조는 이만큼 앞에서부터. 앞 말의 시각보다 앞으로는 안 감. AI 말은 TTS 시작 시각이라 그대로 정확
 *  ponytail: 눈대중 2초 — AI팀이 발화 시작 시각을 주면(A9) 0으로 */
const CUSTOMER_LEAD_SEC = 2
type Timed = Utterance & { labelSec: number | null } // atSec = 듣기 시작 시각, labelSec = 화면에 쓰는 서버 시각
function withLead(utterances: Utterance[]): Timed[] {
  return utterances.map((u, i) => {
    if (u.atSec === null || u.speaker !== 'CUSTOMER') return { ...u, labelSec: u.atSec }
    const prev = utterances.slice(0, i).findLast((p) => p.atSec !== null)?.atSec ?? 0
    return { ...u, atSec: Math.max(prev, u.atSec - CUSTOMER_LEAD_SEC), labelSec: u.atSec }
  })
}

/** 불만은 발화 순번(utteranceOrders)으로 묶음 (명세 §5.2: 실제 있는 발화만 강조) */
function toSegments(utterances: Timed[], complaints: Complaint[]): ScriptSegment[] {
  const segments: ScriptSegment[] = []
  for (const u of utterances) {
    const c = complaints.find((x) => x.utteranceOrders.includes(u.order))
    const line: ScriptLine = {
      key: u.order,
      atSec: u.atSec,
      time: u.labelSec === null ? '' : fmtClock(u.labelSec),
      who: u.speaker === 'AI' ? 'AI' : '고객',
      text: u.text,
    }
    const last = segments[segments.length - 1]
    const sameGroup =
      last && (last.complaint === null) === (c === null) && (!c || last.lines[0].key >= 0)
    if (
      sameGroup &&
      (c === null || complaints.find((x) => x.utteranceOrders.includes(last.lines[0].key)) === c)
    )
      last.lines.push(line)
    else segments.push({ complaint: c ? { label: COMPLAINT_LABEL[c.type] } : null, lines: [line] })
  }
  return segments
}

/** 블록 순서: 주문에 한 일(접수 · 주문 취소 · 이관)이 위, AI 미답변이 아래 — 같은 무리 안에선 통화 순번 (10/28: 미답변이 위면 문의 통화로 읽힘) */
const rank = (r: ResultBlock) => (r.kind === 'QUESTION_UNANSWERED' ? 1 : 0)

/** 영역이 비었을 때 문구 — 받는 중 · 못 받음 · 받았는데 없음을 구분 (명세: 빈 성공 응답과 요청 실패를 구분) */
const emptyText = (
  q: { isPending: boolean; isError: boolean; data?: unknown },
  loading: string,
  failed: string,
  none: string,
) => (q.isPending ? loading : q.isError && !q.data ? failed : none)

/** 06 통화 상세 훅 — 요약 · 스크립트(불만 묶음) · 녹취 재생 · 처리 내용 · AI 동작 · 주문 팝업
 * 네 조회(기본 · 대화 · 처리 결과 · AI 동작)를 따로 받아 5초마다 다시 — 늦게 온 분석 · 발화 · 녹취가 같은 화면에 붙고, 한 영역이 늦거나 실패해도 나머지는 그대로 (11/02 연동 명세) */
export function useCallDetail(callId: number) {
  const navigate = useNavigate()
  const [orderId, setOrderId] = useState<number | null>(null) // '주문 보기 ›'로 연 주문
  // AI 동작을 눌러 짚은 통화 안 시각(초)과, 스크립트가 그 줄로 스크롤할 신호 (누를 때마다 n이 늘어 같은 줄도 다시 스크롤)
  const [cursor, setCursor] = useState<number | null>(null)
  const [jump, setJump] = useState<{ key: number; n: number } | null>(null)

  const detail = useQuery(callQueries.detail(callId))
  const transcript = useQuery(callQueries.transcript(callId))
  const resultsQ = useQuery(callQueries.results(callId))
  const actionsQ = useQuery(callQueries.actions(callId))
  // 기본 정보가 오면 바로 그림. 나머지는 받은 만큼 (아직 못 받은 영역은 빈 칸 + 그 영역 문구)
  const call = detail.data
    ? toCallDetail(detail.data, transcript.data ?? [], resultsQ.data ?? [], actionsQ.data ?? [])
    : undefined
  const player = useRecordingPlayer(call?.recording ?? null, () => {
    void detail.refetch()
  })
  const says = withLead(call?.utterances ?? []) // 듣기 시각이 보정된 말들 (아래 전부 이걸 씀)
  // 지금 짚은 줄: 녹취가 돌면 재생 위치, 아니면 누른 시각 (11/01 사용자: AI 동작을 누르면 왼쪽 그 부분 + 그 부분 음성)
  const at = player.now > 0 ? player.now : cursor
  const focusKey = at === null ? null : (utteranceAt(says, at)?.order ?? null)
  // AI 동작을 누르면 그 동작을 부른 '고객의 말'로 — AI 말이 아니라 (11/01 사용자). 고객 말 처음부터 듣게 그 말의 시각으로 감
  const jumpTo = (sec: number, text: string) => {
    const line = utteranceForAction(says, sec, text)
    const at = line?.atSec ?? sec
    setCursor(at)
    if (line) setJump((j) => ({ key: line.order, n: (j?.n ?? 0) + 1 }))
    player.seek(at)
  }
  /** 스크립트 줄을 눌렀을 때 — 그 말부터 (스크롤은 안 함, 이미 보고 있는 줄) */
  const listenFrom = (sec: number) => {
    setCursor(sec)
    player.seek(sec)
  }

  // 404는 받은 게 있어도 '통화 없음'(삭제된 통화 — 반복 조회도 멈춤). 그 밖의 오류 화면은 아무것도 못 받았을 때만,
  // 받은 게 있으면 그대로 두고(재조회 실패 · 일부만 수신) 안내 한 줄 (11/02 연동 명세)
  const error =
    detail.error instanceof ApiError && detail.error.status === 404
      ? '통화를 찾을 수 없습니다.'
      : call || !detail.error
        ? null
        : '불러오지 못했습니다. 다시 시도해 주세요.'
  // 이미 받은 영역의 재조회가 실패하면 받은 내용은 그대로 두고 한 줄 알림 (다음 갱신에서 다시)
  const notice =
    call && [detail, transcript, resultsQ, actionsQ].some((q) => q.isError && q.data !== undefined)
      ? '다시 받지 못한 부분이 있어요. 마지막으로 받은 내용을 보여 드려요.'
      : null
  // 녹취 한 줄 — 빈 배열은 '아직 연결 안 됨'(업로드 중 · 실패 · 무음으로 단정 안 함), NOT_FOUND와 DEPENDENCY_UNAVAILABLE은 따로 (명세)
  const rec = call?.recording ?? null
  const recordingText = !rec
    ? '녹취가 아직 연결되지 않았어요'
    : player.state !== 'failed'
      ? null
      : rec.error === 'NOT_FOUND'
        ? '녹취 파일을 찾을 수 없어요'
        : rec.error === 'DEPENDENCY_UNAVAILABLE'
          ? '녹취 저장소에 연결하지 못했어요 · 다시 받는 중'
          : !rec.url
            ? '녹취 주소를 받지 못했어요 · 다시 받는 중'
            : '녹취를 재생하지 못했어요 · 다시 받는 중'

  // 미답변 기록 → 통화 안 시각(초)별 사유 문구. AI는 미답변을 그 질문을 찾은 FAQ 검색과 같은 시각으로 보냄
  // 지운 미답변(질문 · 사유 null)은 사유를 몰라 빼서 검색 요약을 그대로 둠
  const unansweredAt = new Map(
    (call?.results ?? []).flatMap((r) =>
      r.kind === 'QUESTION_UNANSWERED' && r.question !== null && r.atSec !== null
        ? [[r.atSec, reasonTag(r.reason).label] as const]
        : [],
    ),
  )
  const results: ResultView[] = call
    ? [...call.results]
        .filter((r) => RESULT_LABEL[r.kind]) // 문의 · 답한 FAQ 블록은 안 그림
        .sort((a, b) => rank(a) - rank(b) || a.order - b.order)
        .map((r) => {
          const base = {
            key: `${r.kind}-${r.order}`,
            label: RESULT_LABEL[r.kind]!,
            time: r.atSec === null ? '' : fmtClock(r.atSec),
          }
          if (r.kind === 'QUESTION_UNANSWERED')
            return r.question === null
              ? base // 삭제된 질문: 원문도 링크도 없음
              : {
                  ...base,
                  question: r.question,
                  reason: reasonTag(r.reason),
                  // 그 통화의 질문만 (10/30 사용자: 미답변 보기를 누르면 해당 통화 것만)
                  link: {
                    label: 'AI 미답변 보기',
                    onClick: () => navigate(unansweredTo(`/calls/${callId}`, callId)), // 경로 '통화 상세 > AI 미답변 > 강도윤 통화'
                  },
                }
          if (r.orderSeq !== null) {
            const orderSeq = r.orderSeq
            return { ...base, link: { label: '주문 보기', onClick: () => setOrderId(orderSeq) } }
          }
          return base
        })
    : []

  return {
    isLoading: detail.isPending,
    error,
    notice,

    // 머리 (11/04 새 디자인 — 04 줄과 같은 말): 고객 이름(신규면 new) + 상담 유형 칩 / 발신번호 · 시작 시각 · 통화 시간 · 상담가 / 불만 줄
    // 옛 '통화 결과' 태그는 뺌 — 서버가 11/04 result를 빼서 실서버에선 늘 '분석 전'으로 보였음
    summary: call
      ? {
          customer: call.customerName ?? '—',
          isNew: call.isNew === true,
          kinds: kindChips(call.counts),
          analyzed: call.counts !== null, // 분석 전이면 칩 대신 '분석 전'
          startedAt: call.startedAt ? fmtDetailTime(call.startedAt, { seconds: true }) : '—',
          duration: call.durationSec === null ? '—' : fmtDuration(call.durationSec),
          caller: call.callerNumber ? fmtPhone(call.callerNumber) : '—',
          complaints: call.complaints.map((c) => ({
            label: COMPLAINT_LABEL[c.type],
            reason: c.reason,
          })),
        }
      : null,

    // 스크립트 (말만) + 녹취 재생
    persona: call?.persona ? `${call.persona.name} v${call.persona.version}` : '',
    player: {
      state: player.state,
      playing: player.playing,
      now: fmtClock(Math.floor(player.now)),
      length: fmtClock(Math.floor(player.length || call?.durationSec || 0)),
      progress: player.progress,
      toggle: player.toggle,
      scrub: player.scrub, // 진행 바 드래그 (11/01)
      src: player.src,
      handlers: player.handlers,
      text: recordingText, // 재생 줄 아래 한 줄 (없으면 '지금 / 길이')
    },
    audioRef: player.audioRef, // <audio>에 꽂을 ref — player와 따로 넘김 (렌더 중 ref 접근 규칙)
    // 스크립트 줄을 누르면 그 말부터 듣기 (11/01) — 시각을 아는 줄만
    segments: call
      ? toSegments(says, call.complaints).map((seg) => ({
          ...seg,
          lines: seg.lines.map((l) => {
            const sec = l.atSec
            return sec === null ? l : { ...l, onClick: () => listenFrom(sec) }
          }),
        }))
      : [],
    scriptEmpty: emptyText(
      transcript,
      '대화를 불러오는 중…',
      '대화를 받지 못했어요. 잠시 뒤 다시 받아요.',
      '발화가 없습니다.',
    ),
    resultsEmpty: emptyText(
      resultsQ,
      '처리 내역을 불러오는 중…',
      '처리 내역을 받지 못했어요. 잠시 뒤 다시 받아요.',
      '이 통화로 처리된 주문 · 미답변이 없습니다.',
    ),
    actionsEmpty: emptyText(
      actionsQ,
      'AI 동작을 불러오는 중…',
      'AI 동작을 받지 못했어요. 잠시 뒤 다시 받아요.',
      '기록이 없습니다.',
    ),
    focusKey, // 옅은 남색으로 짚는 줄 (발화 순번)
    jump, // 그 줄로 스크롤 (AI 동작을 눌렀을 때만 — 재생 중엔 강조만 따라가고 스크롤은 안 함)

    // 처리 내용
    results,
    actions: (call?.actions ?? []).map((a): ActionView => {
      const sec = a.atSec
      return {
        key: a.order,
        time: sec === null ? '' : fmtClock(sec),
        tag: ACTION_LABEL[a.kind],
        // 서버 summaryText 그대로. 단 미답변으로 기록된 FAQ 검색은 'FAQ 근거 있음' 같은 검색 요약 대신 미답변 사유 (11/04 AI팀)
        text: (a.kind === 'FAQ_SEARCH' && sec !== null && unansweredAt.get(sec)) || a.text,
        onClick: sec === null ? undefined : () => jumpTo(sec, a.text),
      }
    }),
    actionCount: call?.aiActionCount ?? 0,

    // 주문 팝업 (shared/order/OrderDetailModal — 03 주문 내역과 같은 창). 06은 읽기만: [수정]은 03에서 (통화 ≠ 주문, 10/28)
    orderId, // null이 아니면 팝업
    closeOrder: () => setOrderId(null),
  }
}
