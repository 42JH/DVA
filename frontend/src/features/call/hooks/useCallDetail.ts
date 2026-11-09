import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { fmtClock, fmtPhone } from '@/shared/lib/format'
import { COMPLAINT_LABEL } from '@/features/call/labels'
import {
  callQueries,
  poll,
  type Complaint,
  toCallDetail,
  type Utterance,
} from '@/shared/call/callApi'
import { utteranceAt, utteranceForAction, type CallActionKind } from '@/shared/call/callDto'
import { faqResultText, groupActions } from '@/shared/call/actionText'
import { useRecordingPlayer } from './useRecordingPlayer'

/** 스크립트 한 줄 (말만 — AI 동작은 오른쪽 처리 내용으로, 10/30). onClick = 이 말부터 듣기 (11/01, 시각을 모르면 없음) */
interface ScriptLine {
  key: number // 발화 순번 (= 서버 order)
  atSec: number | null
  time: string // '00:31' (위치를 모르면 '')
  who: 'AI' | '고객'
  text: string
  onClick?: () => void
}
/** 연속 구간: 불만이면 빨간 묶음으로 */
interface ScriptSegment {
  complaint: { label: string } | null
  lines: ScriptLine[]
}

/** AI 동작 기록 한 줄. onClick = 그 동작을 부른 고객 말로 스크립트를 넘기고 녹취를 그 말부터 재생 (시각을 모르면 없음) */
interface ActionView {
  key: number
  kind: CallActionKind // 아이콘 (조회 · 저장 · 검색 · 전송 · 취소)
  text: string
  active: boolean // 지금 짚은 말이 부른 동작 — 하이라이트
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
    // 앞 말 시작까지 당기면 두 줄 시각이 같아져 앞 줄이 하이라이트 · ⏮로 못 감(11/05 실서버 'AI 00:51' · '고객 네 00:52') → 앞 말과의 중간까지만
    const lead = Math.max(u.atSec - CUSTOMER_LEAD_SEC, (prev + u.atSec) / 2)
    return { ...u, atSec: Math.max(prev, lead), labelSec: u.atSec }
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

/** 영역이 비었을 때 문구 — 받는 중 · 못 받음 · 받았는데 없음을 구분 (명세: 빈 성공 응답과 요청 실패를 구분) */
const emptyText = (
  q: { isPending: boolean; isError: boolean; data?: unknown },
  loading: string,
  failed: string,
  none: string,
) => (q.isPending ? loading : q.isError && !q.data ? failed : none)

/** 06 통화 상세 훅 (11/05 새 디자인) — 대본(불만 묶음) · 녹취 재생(이전 · 다음 발화 · 음량) · AI 동작(짚은 말과 같이 하이라이트)
 * 네 조회(기본 · 대화 · 처리 결과 · AI 동작)를 따로 받아 5초마다 다시 — 늦게 온 분석 · 발화 · 녹취가 같은 화면에 붙고, 한 영역이 늦거나 실패해도 나머지는 그대로 (11/02 연동 명세) */
export function useCallDetail(callId: number, fromFaq?: number) {
  // AI 동작을 눌러 짚은 통화 안 시각(초)과, 스크립트가 그 줄로 스크롤할 신호 (누를 때마다 n이 늘어 같은 줄도 다시 스크롤)
  const [cursor, setCursor] = useState<number | null>(null)
  const [jump, setJump] = useState<{ key: number; n: number } | null>(null)
  // 고른 줄 (누름 · ⏮ ⏭ · AI 동작) — 시각이 같은 줄이 여럿이면 시각만으로는 앞 줄을 못 고름(뒤 줄이 이김) → 고른 줄을 다음 줄 시작 전까지 붙잡음
  const [pin, setPin] = useState<{ key: number; sec: number } | null>(null)

  // 끝나고 분석까지 끝났고 녹취도 왔으면 더 올 게 없음 → 5초 반복을 멈춤 (11/09 검수: 다 끝난 통화를 열어 두면 네 요청을 계속 보냄)
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
  // 지금 짚은 줄: 녹취가 돌면 재생 위치, 아니면 누른 시각 (11/01 사용자: AI 동작을 누르면 왼쪽 그 부분 + 그 부분 음성)
  const at = player.now > 0 ? player.now : cursor
  const pinEnd = pin && says.find((u) => u.atSec !== null && u.atSec > pin.sec)?.atSec
  const pinned = pin && at !== null && at >= pin.sec && (pinEnd == null || at < pinEnd)
  const focusKey = pinned ? pin.key : at === null ? null : (utteranceAt(says, at)?.order ?? null)
  // AI 동작을 누르면 그 동작을 부른 '고객의 말'로 — AI 말이 아니라 (11/01 사용자). 고객 말 처음부터 듣게 그 말의 시각으로 감
  const jumpTo = (sec: number, text: string) => {
    const line = utteranceForAction(says, sec, text)
    const at = line?.atSec ?? sec
    setCursor(at)
    setPin(line ? { key: line.order, sec: at } : null)
    if (line) setJump((j) => ({ key: line.order, n: (j?.n ?? 0) + 1 }))
    player.seek(at)
  }
  /** 그 줄부터 듣기 (스크립트 줄을 누름 · ⏮ ⏭) — 스크롤은 부른 쪽이 */
  const listenFrom = (key: number, sec: number) => {
    setCursor(sec)
    setPin({ key, sec })
    player.seek(sec)
  }

  // 404는 받은 게 있어도 '통화 없음'(삭제된 통화 — 반복 조회도 멈춤). 그 밖의 오류 화면은 아무것도 못 받았을 때만,
  // 받은 게 있으면 그대로 두고(재조회 실패 · 일부만 수신) 안내 한 줄 (11/02 연동 명세)
  // FAQ 상세 고객 질문 사례에서 왔는데 통화가 지워졌으면(404) 그 FAQ 상세를 다시 받아 링크를 갱신 (11/05 명세)
  const qc = useQueryClient()
  const gone = detail.error instanceof ApiError && detail.error.status === 404
  useEffect(() => {
    if (gone && fromFaq) void qc.invalidateQueries({ queryKey: ['faqs', 'detail', fromFaq] })
  }, [gone, fromFaq, qc])

  const error =
    detail.error instanceof ApiError && detail.error.status === 404
      ? '통화 원본이 삭제되어 조회할 수 없습니다.' // FAQ 상세 사례 · 다른 화면에서 온 지워진 통화 (11/05 FAQ 사례 연동 문구)
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

  // FAQ 최종 응대 결과 → 통화 안 시각(초)별 문구 (FAQ_ANSWERED = 근거 있음 · 미답변 = 근거 부족 / 서버 에러, 11/05 AI팀)
  // AI는 결과를 그 질문을 찾은 FAQ 검색과 같은 시각으로 보냄. 지운 미답변(질문 · 사유 null)은 사유를 몰라 뺌
  const faqResultAt = new Map(
    (call?.results ?? []).flatMap((r) =>
      r.atSec !== null &&
      (r.kind === 'FAQ_ANSWERED' || (r.kind === 'QUESTION_UNANSWERED' && r.question !== null))
        ? [[r.atSec, faqResultText(r.kind, r.reason)] as const]
        : [],
    ),
  )
  // 이전 · 다음 발화 (11/05 새 디자인 재생 줄 ⏮ ⏭) — 지금 짚은 말 기준. 짚은 말이 없으면 다음 = 첫 말
  const timed = says.filter((u): u is Timed & { atSec: number } => u.atSec !== null)
  const here = focusKey === null ? -1 : timed.findIndex((u) => u.order === focusKey)
  const goLine = (u: (typeof timed)[number] | undefined) => {
    if (!u) return
    setJump((j) => ({ key: u.order, n: (j?.n ?? 0) + 1 }))
    listenFrom(u.order, u.atSec)
  }

  return {
    isLoading: detail.isPending,
    error,
    notice,

    // 상단바 (11/05 새 디자인): 경로 '통화 > “김민수”님 통화' · 발신번호
    customer: call?.customerName ?? null,
    // 검색 창 '최근 조회' (shared/lib/recentViews) — 받으면 기록, 404면 기록에서 뺌
    recent: call
      ? {
          label: call.customerName ?? '이름 없음',
          sub: call.callerNumber ? [fmtPhone(call.callerNumber)] : undefined,
        }
      : null,
    notFound: detail.error instanceof ApiError && detail.error.status === 404,
    caller: call?.callerNumber ? fmtPhone(call.callerNumber) : '',

    // 대본 + 녹취 재생 (아래 재생 줄)
    persona: call?.persona?.name ?? '', // 재생 줄 왼쪽 '[ 빠른 접수형 ]'
    player: {
      state: player.state,
      playing: player.playing,
      now: fmtClock(Math.floor(player.now)),
      length: fmtClock(Math.floor(player.length || call?.durationSec || 0)),
      progress: player.progress,
      toggle: player.toggle,
      scrub: player.scrub, // 진행 바 드래그 (11/01)
      prev: () => goLine(here > 0 ? timed[here - 1] : timed[0]),
      next: () => goLine(timed[here + 1]),
      volume: player.volume,
      muted: player.muted,
      setVolume: player.setVolume,
      toggleMute: player.toggleMute,
      src: player.src,
      handlers: player.handlers,
      text: recordingText, // 녹취가 없거나 못 들을 때 한 줄
    },
    audioRef: player.audioRef, // <audio>에 꽂을 ref — player와 따로 넘김 (렌더 중 ref 접근 규칙)
    // 대본 줄을 누르면 그 말부터 듣기 (11/01) — 시각을 아는 줄만
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
    actionsEmpty: emptyText(
      actionsQ,
      'AI 동작을 불러오는 중…',
      'AI 동작을 받지 못했어요. 잠시 뒤 다시 받아요.',
      '기록이 없습니다.',
    ),
    focusKey, // 하이라이트하는 줄 (발화 순번)
    jump, // 그 줄로 스크롤 (AI 동작 · 이전 · 다음을 눌렀을 때만 — 재생 중엔 하이라이트만 따라가고 스크롤은 안 함)

    // AI 동작 기록 — 짚은 말이 부른 동작은 같이 하이라이트 (11/05 사용자: AI 동작 로그에도 그 부분 하이라이트)
    // 글은 화면 말로 정제(actionText — 실패 코드 · 주문 상태 · '기록: n개 항목'), 연달아 나온 '기록'은 한 줄로 합침 (11/05 사용자)
    actions: groupActions(call?.actions ?? []).map(({ head, all, text }): ActionView => {
      const sec = head.atSec
      const by = (a: (typeof all)[number]) =>
        a.atSec === null ? null : (utteranceForAction(says, a.atSec, a.text)?.order ?? null)
      return {
        key: head.order,
        kind: head.kind,
        // FAQ 검색 = AI 요약 그대로(검색 후보를 찾았다는 뜻 — '답을 찾음' 아님) + 최종 결과 '· 근거 있음 / 근거 부족 / 서버 에러' (11/05 AI팀)
        text:
          head.kind === 'FAQ_SEARCH' && sec !== null && faqResultAt.has(sec)
            ? `${text} · ${faqResultAt.get(sec)}`
            : text,
        active: focusKey !== null && all.some((a) => by(a) === focusKey),
        onClick: sec === null ? undefined : () => jumpTo(sec, head.text),
      }
    }),
  }
}
