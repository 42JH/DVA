// 06 통화 상세의 계산 — 대본 줄 묶음 · 지금 짚은 줄 · 재생 바 눈금 · AI 동작 줄. React를 모르는 순수 함수 (실행해서 확인: callScript.test.ts)
// 상태(짚은 줄 · 재생 위치)와 조회는 useCallDetail
import { fmtClock } from '@/shared/lib/format'
import { COMPLAINT_LABEL } from '../labels'
import {
  utteranceAt,
  utteranceForAction,
  type AiAction,
  type CallActionKind,
  type Complaint,
  type toCallDetail,
  type Utterance,
} from '@/shared/call/callDto'
import { faqResultText, groupActions } from '@/shared/call/actionText'
import { isCustomerComplaint, splitComplaints, TARGET_LABEL } from '@/shared/call/complaints'

/** 스크립트 한 줄 (말만 — AI 동작은 오른쪽 처리 내용으로, 10/30). onClick = 이 말부터 듣기 (시각을 모르면 없음) */
interface ScriptLine {
  key: number // 발화 순번 (= 서버 order)
  atSec: number | null
  time: string // '00:31' (위치를 모르면 '')
  who: 'AI' | '고객'
  text: string
  onClick?: () => void
  complaint?: string // 고객 불만인 고객 말 — 그 문장만 칠하고 아래에 대상
}
/** 연속 구간: AI 응대 오류면 주황 줄로 묶음 */
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

/** 고객 말의 서버 시각(offsetSeconds)은 음성 인식이 끝난 뒤 찍혀서 실제 말보다 늦음 — 빨리 말하면 그 말을 놓침 (, 실서버 녹취)
 *  → 듣기 · 강조는 이만큼 앞에서부터. 앞 말의 시각보다 앞으로는 안 감. AI 말은 TTS 시작 시각이라 그대로 정확
 *  ponytail: 눈대중 2초 — AI팀이 발화 시작 시각을 주면(A9) 0으로 */
const CUSTOMER_LEAD_SEC = 2
export type Timed = Utterance & { labelSec: number | null } // atSec = 듣기 시작 시각, labelSec = 화면에 쓰는 서버 시각
export function withLead(utterances: Utterance[]): Timed[] {
  return utterances.map((u, i) => {
    if (u.atSec === null || u.speaker !== 'CUSTOMER') return { ...u, labelSec: u.atSec }
    const prev = utterances.slice(0, i).findLast((p) => p.atSec !== null)?.atSec ?? 0
    // 앞 말 시작까지 당기면 두 줄 시각이 같아져 앞 줄이 하이라이트 · ⏮로 못 감 (실서버 'AI 00:51' · '고객 네 00:52') → 앞 말과의 중간까지만
    const lead = Math.max(u.atSec - CUSTOMER_LEAD_SEC, (prev + u.atSec) / 2)
    return { ...u, atSec: Math.max(prev, lead), labelSec: u.atSec }
  })
}

/** 발화 순번(utteranceOrders)으로 (명세 §5.2: 실제 있는 발화만 강조) — AI 응대 오류는 구간으로 묶고, 고객 불만은 그 고객 말만 표시 */
export function toSegments(utterances: Timed[], all: Complaint[]): ScriptSegment[] {
  const { customer, errors: complaints } = splitComplaints(all)
  const segments: ScriptSegment[] = []
  for (const u of utterances) {
    const c = complaints.find((x) => x.utteranceOrders.includes(u.order)) ?? null
    const said =
      u.speaker === 'CUSTOMER' && customer.find((x) => x.utteranceOrders.includes(u.order))
    const line: ScriptLine = {
      key: u.order,
      atSec: u.atSec,
      time: u.labelSec === null ? '' : fmtClock(u.labelSec),
      who: u.speaker === 'AI' ? 'AI' : '고객',
      text: u.text,
      ...(said ? { complaint: TARGET_LABEL[said.target] } : {}),
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
export const emptyText = (
  q: { isPending: boolean; isError: boolean; data?: unknown },
  loading: string,
  failed: string,
  none: string,
) => (q.isPending ? loading : q.isError && !q.data ? failed : none)

/** 녹취 한 줄 — 빈 배열은 '아직 연결 안 됨'(업로드 중 · 실패 · 무음으로 단정 안 함), NOT_FOUND와 DEPENDENCY_UNAVAILABLE은 따로 (명세) */
export const recordingNote = (
  rec: ReturnType<typeof toCallDetail>['recording'],
  failed: boolean,
) => {
  if (!rec) return '녹취가 아직 연결되지 않았어요'
  if (!failed) return null
  if (rec.error === 'NOT_FOUND') return '녹취 파일을 찾을 수 없어요'
  if (rec.error === 'DEPENDENCY_UNAVAILABLE') return '녹취 저장소에 연결하지 못했어요. 다시 받는 중'
  return rec.url
    ? '녹취를 재생하지 못했어요. 다시 받는 중'
    : '녹취 주소를 받지 못했어요. 다시 받는 중'
}

type CallDetail = ReturnType<typeof toCallDetail>

/** 지금 짚은 줄 — 고른 줄(pin)은 다음 줄 시작 전까지 붙들고, 아니면 그 시각의 말 (at = 재생 위치 · 누른 시각, 없으면 null)
 *  시각이 같은 줄이 여럿이면 시각만으로는 앞 줄을 못 고름(뒤 줄이 이김) → 고른 줄을 붙듦 */
export function focusOf(
  says: Timed[],
  at: number | null,
  pin: { key: number; sec: number } | null,
): number | null {
  if (at === null) return null
  if (pin && at >= pin.sec) {
    const pinEnd = says.find((u) => u.atSec !== null && u.atSec > pin.sec)?.atSec
    if (pinEnd == null || at < pinEnd) return pin.key
  }
  return utteranceAt(says, at)?.order ?? null
}

/** FAQ 최종 응대 결과 → 통화 안 시각(초)별 문구 (FAQ_ANSWERED = 근거 있음 · 미답변 = 근거 부족 / 서버 에러, 11/05 AI팀)
 *  AI는 결과를 그 질문을 찾은 FAQ 검색과 같은 시각으로 보냄. 지운 미답변(질문 · 사유 null)은 사유를 몰라 뺌 */
export const faqResultTimes = (results: CallDetail['results']) =>
  new Map(
    results.flatMap((r) =>
      r.atSec !== null &&
      (r.kind === 'FAQ_ANSWERED' || (r.kind === 'QUESTION_UNANSWERED' && r.question !== null))
        ? [[r.atSec, faqResultText(r.kind, r.reason)] as const]
        : [],
    ),
  )

/** 재생 바의 고객 불만(빨강) · AI 응대 오류(주황) 시각 눈금. 누르면 그 말로. 길이를 모르면 없음
 *  shift = 녹취가 통화 시작보다 늦게 시작한 만큼(초) */
export function marksOf(
  complaints: Complaint[],
  says: Timed[],
  x: { shift: number; lengthSec: number; go: (c: Complaint) => void },
) {
  if (!x.lengthSec) return []
  const { customer, errors } = splitComplaints(complaints)
  return [...customer, ...errors].flatMap((c, i) => {
    const sec = c.offsetSeconds ?? says.find((u) => c.utteranceOrders.includes(u.order))?.labelSec
    if (sec == null) return []
    const cust = isCustomerComplaint(c)
    return [
      {
        key: i,
        at: Math.min(1, Math.max(0, (sec - x.shift) / x.lengthSec)),
        tone: cust ? ('stop' as const) : ('wait' as const),
        title: `${cust ? TARGET_LABEL[c.target] : COMPLAINT_LABEL[c.type]} ${fmtClock(Math.floor(sec))}`,
        onClick: () => x.go(c),
      },
    ]
  })
}

/** AI 동작 기록 — 짚은 말이 부른 동작은 같이 하이라이트 (AI 동작 로그에도 그 부분 하이라이트)
 *  글은 화면 말로 정제(actionText — 실패 코드 · 주문 상태 · '기록: n개 항목'), 연달아 나온 '기록'은 한 줄로 합침 */
export function actionViews(
  actions: AiAction[],
  says: Timed[],
  x: {
    faqResultAt: Map<number, string>
    focusKey: number | null
    jumpTo: (sec: number, text: string) => void
  },
): ActionView[] {
  return groupActions(actions).map(({ head, all, text }) => {
    const sec = head.atSec
    const by = (a: (typeof all)[number]) =>
      a.atSec === null ? null : (utteranceForAction(says, a.atSec, a.text)?.order ?? null)
    // FAQ 검색 = AI 요약 그대로(검색 후보를 찾았다는 뜻 — '답을 찾음' 아님) + 최종 결과 '· 근거 있음 / 근거 부족 / 서버 에러' (AI팀)
    const result = head.kind === 'FAQ_SEARCH' && sec !== null ? x.faqResultAt.get(sec) : undefined
    return {
      key: head.order,
      kind: head.kind,
      text: result === undefined ? text : `${text}, ${result}`,
      active: x.focusKey !== null && all.some((a) => by(a) === x.focusKey),
      onClick: sec === null ? undefined : () => x.jumpTo(sec, head.text),
    }
  })
}
