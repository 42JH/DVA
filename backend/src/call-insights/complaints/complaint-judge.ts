// 통화 불만 판정 (후처리 전용) — 끝난 통화의 저장된 기록(EVT-01 이벤트)을 코드가 차례로 나누고, 모델이 차례마다 정해진 칸을 채운다.
// 기준 구현: ai/call_analysis/analyze.py (정답 묶음으로 점수를 잰 코드). 규칙을 바꿀 때는 파이썬에서 점수를 다시 재고 같이 고친다.
// 모델 결과는 미신뢰 입력이라 check()가 입력에 있는 차례, 정해진 값, 행동과 맞는 문제만 남긴다.
// 같은 통화를 VOTES번 동시에 판정해 같은 차례 · 같은 문제가 NEED번 이상 나온 것만 남긴다(다수결).
import { JUDGE_PROMPT, VERIFY_PROMPT } from './complaint-prompts';
import { Segment, pauses, pyRound } from './complaint-timing';

export const MODEL = 'gpt-6-luna';
export const EFFORT = 'medium';
export const VOTES = 3;
export const NEED = 2;
export const MAX_INPUT_CHARS = 40_000;
const MAX_WHY = 200;
const MAX_SUMMARY = 120;
const MAX_QUOTE = 80;

export const CUST = [
  'answer',
  'question',
  'request',
  'correct',
  'confirm',
  'ask_back',
  'wait',
  'complain',
  'end',
  'other',
] as const;
export const AI = [
  'ask',
  'inform',
  'confirm',
  'process',
  'handoff',
  'refuse',
  'wait',
  'close',
  'other',
] as const;
export const FIELDS = [
  'sender_name',
  'sender_phone',
  'sender_address',
  'receiver_name',
  'receiver_phone',
  'receiver_address',
  'item',
  'item_price',
  'pickup_at',
  'payment',
] as const;
const BASIS = ['faq', 'tool', 'order', 'none', 'na'] as const;
// 말 끊김 · 응답 지연은 모델이 고르지 않는다 — 대본 · 녹음 사실로 코드가 정한다(complaint-facts)
export const ISSUES = [
  'RECOGNITION_FAILURE',
  'INTENT_FAILURE',
  'UNGROUNDED_ANSWER',
  'CUSTOMER_CONFUSION',
  'FRUSTRATION',
] as const;
const PURPOSES = ['register', 'lookup', 'cancel', 'inquiry', 'handoff', 'other'] as const;
const GOALS = ['achieved', 'partial', 'failed', 'none'] as const;
const MOODS = ['positive', 'neutral', 'negative'] as const;

// 차례에 붙이는 AI 동작(EVT-01 AI_ACTION) · AI 서버의 통화 후 FAQ 검토(BUSINESS_RESULT)
const TOOLS: Record<string, string> = {
  FAQ_SEARCH: 'FAQ 검색',
  PREVIOUS_ORDER_SEARCH: '택배 조회',
  FIELD_SAVED: '정보 기록',
  PIN_SEARCH: '주소록 찾기',
  ORDER_CANCELLED: '택배 취소',
};
const REVIEWS: Record<string, string> = {
  FAQ_ANSWERED: 'FAQ 검토',
  QUESTION_UNANSWERED: '답 못한 질문',
};
const LABELS: Record<string, string> = { ...TOOLS, ...REVIEWS };
const KB_DOWN = '장애';
const SEARCHES = ['FAQ_SEARCH', 'PREVIOUS_ORDER_SEARCH'];
const OLD_DOWN = ['매뉴얼 검색 미연결', '매뉴얼 검색 실패', '처리 시간 초과', '내부 오류'];
// ponytail: AI 서버 도구의 시스템 오류 코드만 골랐다. 새 코드가 생기면 여기에 더한다
const NEW_DOWN = [
  'TIMEOUT',
  'UNAVAILABLE',
  'TRANSPORT',
  'INTERNAL',
  'RESPONSE_INVALID',
  'unavailable',
  'unknown',
];
const PHONE_REJECT = 'PHONE_INVALID_DIGITS';
const NATIVE: [string, string][] = [
  ['다섯', '5'],
  ['여섯', '6'],
  ['일곱', '7'],
  ['여덟', '8'],
  ['아홉', '9'],
  ['하나', '1'],
  ['둘', '2'],
  ['셋', '3'],
  ['넷', '4'],
];
const SINO: Record<string, string> = {
  공: '0',
  영: '0',
  일: '1',
  이: '2',
  삼: '3',
  사: '4',
  오: '5',
  육: '6',
  륙: '6',
  칠: '7',
  팔: '8',
  구: '9',
};
const TAILS = [
  '입니다',
  '이에요',
  '이고요',
  '이요',
  '예요',
  '에요',
  '고요',
  '이고',
  '이랑',
  '랑',
  '요',
  '에',
  '고',
];
// 파이썬 \w · \W · \d · \s (유니코드)와 같게
const SENTENCE_END = /(다|요|까|죠|네|세요|군요|[.?!~])[^\p{L}\p{N}_]*$/u;
const DIGITS = /\p{Nd}[\p{Nd}\s-]+\p{Nd}/gu;
const IS_DIGIT = /^\p{Nd}$/u;

export type Issue = (typeof ISSUES)[number];

export interface Utterance {
  order: number;
  customer: boolean;
  text: string;
  at: number; // 통화 시작부터 초
  offset: number | null; // offsetSeconds (불만 offsetSeconds의 기준)
  pause: number | null; // 녹음에서 잰 이 발화 앞 침묵(초)
  pauseGuessed: boolean;
  cut: boolean; // AI 말이 문장 중간에서 끝나고 고객이 바로 말함 = 말 끊김 근거
}

export interface Turn {
  no: number;
  utterances: Utterance[];
  actions: [number, string, string][]; // (시각, 동작 코드, 결과 요약)
  down: boolean; // 장애 구간
}

export interface CallRecord {
  turns: Turn[];
  results: string[];
  sessionId: string;
  speech: Segment[] | null;
}

export interface CallEvent {
  kind: 'UTTERANCE' | 'AI_ACTION' | 'BUSINESS_RESULT';
  occurredAt: string;
  offsetSeconds: number | null;
  payload: Record<string, unknown>;
}

export interface JudgedTurn {
  t: number;
  complain: boolean;
  cust: string[];
  given: string[];
  ai: string[];
  asked: string[];
  basis: string;
  issue: Issue | null;
  why: string;
  quote?: string;
}

export interface Judged {
  turns: JudgedTurn[];
  call: { purposes: string[]; goal: string | null; mood: string | null; summary: string };
  missing?: number;
}

export interface Usage {
  input: number | null;
  cached: number | null;
  output: number | null;
  reasoning: number | null;
}

/** 모델 호출 한 번 — 지시문 · 입력 · 스키마 이름 · 스키마 → (결과 JSON, 토큰). 실패하면 throw */
export type AskModel = (
  instructions: string,
  input: string,
  name: string,
  schema: object,
) => Promise<{ data: unknown; usage: Usage | null }>;

const chars = (s: string) => [...s];
const pySplitJoin = (s: string) => s.split(/\s+/u).filter(Boolean).join(' ');
const has = (list: readonly string[], v: unknown): v is string =>
  typeof v === 'string' && list.includes(v);

/** 말 한 덩어리 → 숫자. 전부 숫자 말(공일공 · 하나둘 · 010)이어야 하고, 아니면 null */
export function digitsOf(token: string): string | null {
  for (const tail of TAILS) {
    if (token.endsWith(tail) && chars(token).length > chars(tail).length) {
      token = token.slice(0, -tail.length);
      break;
    }
  }
  let out = '';
  while (token) {
    const first = chars(token)[0];
    const word = NATIVE.find(([w]) => token.startsWith(w));
    if (IS_DIGIT.test(first)) {
      out += first;
      token = token.slice(first.length);
    } else if (word) {
      out += word[1];
      token = token.slice(word[0].length);
    } else if (first in SINO) {
      out += SINO[first];
      token = token.slice(first.length);
    } else return null;
  }
  return out;
}

/** 고객이 말한 번호가 자릿수 기준에 맞는지. true = 맞음(AI가 틀리게 거절) · false = 분명히 틀림 · null = 모름 */
export function spokenPhoneOk(text: string): boolean | null {
  if (['십', '백', '천', '만'].some((w) => text.includes(w))) return null;
  const digits = text
    .split(/[\s,.·-]+/u)
    .filter(Boolean)
    .map(digitsOf)
    .filter((d): d is string => d !== null)
    .join('');
  const n = chars(digits).length;
  if (n < 9) return null;
  if (/^1[568]\p{Nd}{6}$/u.test(digits)) return true;
  if (digits.startsWith('010')) return n === 11;
  return digits.startsWith('0') && n >= 9 && n <= 11;
}

function isDown(action: string, text: string): boolean {
  if (action === 'QUESTION_UNANSWERED') return text.includes(KB_DOWN);
  if (!SEARCHES.includes(action)) return false;
  const old = text.startsWith('실패: ') ? text.slice('실패: '.length) : text;
  if (text === '주문 조회 실패' || OLD_DOWN.includes(old)) return true;
  const prefix = '실패·재질문: ';
  return text.startsWith(prefix) && NEW_DOWN.some((m) => text.slice(prefix.length).includes(m));
}

/** EVT-01 이벤트(백엔드에 저장된 통화 기록)로 차례를 만든다. 시각 기준은 통화 시작(고객 확인 CUSTOMER_LOOKUP) */
export function fromEvents(
  events: CallEvent[],
  sessionId = '',
  speech: Segment[] | null = null,
): CallRecord {
  const ts = (e: CallEvent) => Date.parse(e.occurredAt) / 1000;
  const lookup = events.find((e) => e.payload?.action === 'CUSTOMER_LOOKUP');
  const start = lookup ? ts(lookup) : events.length ? Math.min(...events.map(ts)) : 0;
  const utterances: Utterance[] = [];
  const actions: [number, string, string][] = [];
  const results: string[] = [];
  const answered = new Map<string, number>();
  for (const e of events) {
    const p = e.payload ?? {};
    const action = typeof p.action === 'string' ? p.action : undefined;
    const text = p.summaryText == null ? '' : String(p.summaryText);
    const said = p.utteranceText == null ? '' : String(p.utteranceText);
    if (e.kind === 'UTTERANCE' && said.trim()) {
      utterances.push({
        order: Number(p.utteranceOrder),
        customer: p.speaker === 'CUSTOMER',
        text: said.trim(),
        at: ts(e) - start,
        offset: e.offsetSeconds ?? null,
        pause: null,
        pauseGuessed: false,
        cut: false,
      });
    } else if (
      (e.kind === 'AI_ACTION' && action && action in TOOLS) ||
      (e.kind === 'BUSINESS_RESULT' && action && action in REVIEWS)
    ) {
      const at = ts(e) - start;
      actions.push([at, action, text]);
      if (Number.isInteger(p.answerUtteranceOrder))
        answered.set(JSON.stringify([at, action, text]), p.answerUtteranceOrder as number);
    } else if (
      (e.kind === 'BUSINESS_RESULT' || action === 'ORDER_SUBMITTED') &&
      text &&
      !results.includes(text)
    ) {
      results.push(text);
    }
  }
  utterances.sort((a, b) => a.order - b.order);
  if (speech) {
    const ps = pauses(
      utterances.map((u) => u.offset),
      speech,
      utterances.map((u) => [u.customer, u.text]),
    );
    utterances.forEach((u, i) => {
      const p = ps[i];
      u.pause = p ? p[0] : null;
      u.pauseGuessed = p ? p[1] : false;
    });
  }
  for (let i = 0; i + 1 < utterances.length; i++) {
    const u = utterances[i];
    u.cut = !u.customer && utterances[i + 1].customer && !SENTENCE_END.test(u.text);
  }
  const turns: Turn[] = [];
  for (const u of utterances) {
    if (u.customer || !turns.length)
      turns.push({ no: turns.length + 1, utterances: [], actions: [], down: false });
    turns[turns.length - 1].utterances.push(u);
  }
  const sorted = [...actions].sort((a, b) => a[0] - b[0] || cmp(a[1], b[1]) || cmp(a[2], b[2]));
  for (const [at, action, text] of sorted) {
    const order = answered.get(JSON.stringify([at, action, text]));
    let turn = order ? turns.find((t) => t.utterances.some((u) => u.order === order)) : undefined;
    turn ??= [...turns].reverse().find((t) => t.utterances[0].at <= at) ?? turns[0];
    if (turn) {
      turn.actions.push([at, action, text]);
      turn.down ||= isDown(action, text);
    }
  }
  return { turns, results, sessionId, speech };
}

/** 파이썬 문자열 비교(코드 포인트 순)와 같게 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 모델 입력: 차례마다 발화와 그 사이 AI 동작, 끝에 업무 결과. only = 이 차례들만(장면 확인용) · mark = 앞에 ▶를 붙일 차례 */
export function describe(rec: CallRecord, only?: Set<number>, mark?: Set<number>): string {
  const lines: string[] = [];
  for (const t of rec.turns) {
    if (only && !only.has(t.no)) continue;
    const rows: [number, number, string][] = t.utterances.map((u) => [
      u.at,
      0,
      `  ${u.customer ? '고객' : 'AI'}: ${u.text}` + (u.cut ? ' (고객이 끼어들어 끊김)' : ''),
    ]);
    for (const u of t.utterances)
      if (u.pause)
        rows.push([
          u.at,
          -1,
          `  · 침묵 ${u.pauseGuessed ? '약 ' : ''}${pyRound(u.pause, 0).toFixed(0)}초` +
            (u.pauseGuessed ? ' (대본 어림)' : ''),
        ]);
    for (const [at, action, text] of t.actions)
      rows.push([at, 1, `  · AI 동작 ${LABELS[action]}: ${text}`]);
    lines.push(
      (mark && mark.size && mark.has(t.no) ? '▶' : '') +
        `차례 ${t.no}` +
        (t.down ? ' (장애 구간)' : ''),
    );
    rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    lines.push(...rows.map((r) => r[2]));
  }
  if (!only) lines.push('', '업무 결과: ' + (rec.results.join(' · ') || '없음'));
  return lines.join('\n');
}

/** 판정 지시문 = 지시문 + (있으면) FAQ 원문. FAQ는 통화마다 같아 앞부분 캐시가 걸린다 */
export function instructions(
  faqs: { question?: unknown; answer?: unknown }[] | null,
  prompt = JUDGE_PROMPT,
): string {
  if (!faqs?.length) return prompt;
  const one = (v: unknown) => pySplitJoin(pyStr(v));
  const rows = faqs.map((f) => `- Q: ${one(f.question)}\n  A: ${one(f.answer)}`);
  return `${prompt}\n\n## FAQ 원문 (AI가 검색해 답할 수 있는 안내 자료 전체)\n\n` + rows.join('\n');
}

const codes = (values: readonly string[]) => ({
  type: 'array',
  items: { type: 'string', enum: [...values] },
});
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['turns', 'call'],
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['t', 'cust', 'given', 'ai', 'asked', 'basis', 'issue', 'why', 'quote'],
        properties: {
          t: { type: 'integer' },
          cust: codes(CUST),
          given: codes(FIELDS),
          ai: codes(AI),
          asked: codes(FIELDS),
          basis: { type: 'string', enum: [...BASIS] },
          issue: { type: 'string', enum: ['none', ...ISSUES] },
          why: { type: 'string' },
          quote: { type: 'string' },
        },
      },
    },
    call: {
      type: 'object',
      additionalProperties: false,
      required: ['purposes', 'goal', 'mood', 'summary'],
      properties: {
        purposes: codes(PURPOSES),
        goal: { type: 'string', enum: [...GOALS] },
        mood: { type: 'string', enum: [...MOODS] },
        summary: { type: 'string' },
      },
    },
  },
};

function pick(values: unknown, allowed: readonly string[]): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(values) ? values : [])
    if (has(allowed, v) && !out.includes(v)) out.push(v);
  return out;
}

/** 파이썬 str() — 판정 결과 칸이 문자열이 아닐 때 */
function pyStr(v: unknown): string {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return '';
  if (v === true) return 'True';
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v);
}

/** 화면 · 로그로 나가는 글: 제어 문자는 빼고, 세 자리 넘게 이어진 숫자(번호 · 금액)는 가린다 */
export function clean(text: unknown, limit: number): string {
  const printable = [...pyStr(text)]
    .map((c) => (/[\p{C}\p{Z}]/u.test(c) && c !== ' ' ? ' ' : c))
    .join('');
  return chars(pySplitJoin(printable).replace(DIGITS, '***')).slice(0, limit).join('');
}

/** 근거 인용이 그 차례나 바로 앞뒤 차례 발화에 글자 그대로 있는지(띄어쓰기 · 문장부호 무시, 네 글자 이상) */
function quoted(quote: string, rec: CallRecord, no: number): boolean {
  const norm = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, '');
  const q = norm(quote);
  return (
    chars(q).length >= 4 &&
    rec.turns.some(
      (t) => Math.abs(t.no - no) <= 1 && t.utterances.some((u) => norm(u.text).includes(q)),
    )
  );
}

/** 모델 결과 검사: 입력에 있는 차례만 한 번씩, 정해진 값만. 행동과 맞지 않는 문제 · 대본에 없는 인용은 버린다 */
export function check(raw: unknown, rec: CallRecord): Judged {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const byNo = new Map(rec.turns.map((t) => [t.no, t]));
  const turns = new Map<number, JudgedTurn>();
  for (const item of Array.isArray(obj.turns) ? obj.turns : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    let r = item as Record<string, unknown>;
    const no = r.t;
    if (typeof no !== 'number' || !Number.isInteger(no) || !byNo.has(no) || turns.has(no)) continue;
    const turn = byNo.get(no)!;
    const cust = pick(r.cust, CUST);
    const ai = pick(r.ai, AI);
    const basis = has(BASIS, r.basis) ? r.basis : 'na';
    let issue: Issue | null = has(ISSUES, r.issue) ? (r.issue as Issue) : null;
    const fits: Partial<Record<Issue, boolean>> = {
      UNGROUNDED_ANSWER: ai.includes('inform') && basis === 'none',
      CUSTOMER_CONFUSION: cust.includes('ask_back'),
      FRUSTRATION: cust.includes('complain'),
    };
    if (issue && fits[issue] === false) issue = null;
    if (issue === 'UNGROUNDED_ANSWER' && turn.actions.some(([, a]) => a in REVIEWS)) issue = null;
    const quote = pySplitJoin(pyStr(r.quote));
    if (issue && !quoted(quote, rec, no)) issue = null;
    if (!turn.down && turn.actions.some(([, , txt]) => txt.includes(PHONE_REJECT))) {
      const ok = spokenPhoneOk(
        turn.utterances
          .filter((u) => u.customer)
          .map((u) => u.text)
          .join(' '),
      );
      if (ok === false && issue === 'RECOGNITION_FAILURE') issue = null;
      else if (ok === true && issue === null) {
        issue = 'RECOGNITION_FAILURE';
        r = { ...r, why: '맞는 번호를 자릿수가 틀렸다며 다시 물음' };
      }
    }
    const out: JudgedTurn = {
      t: no,
      complain: cust.includes('complain') && !turn.down,
      cust,
      given: pick(r.given, FIELDS),
      ai,
      asked: pick(r.asked, FIELDS),
      basis,
      issue,
      why: issue ? clean(r.why, MAX_WHY) : '',
    };
    if ('quote' in r) out.quote = issue ? clean(quote, MAX_QUOTE) : '';
    turns.set(no, out);
  }
  const c =
    obj.call && typeof obj.call === 'object' && !Array.isArray(obj.call)
      ? (obj.call as Record<string, unknown>)
      : {};
  return {
    turns: [...turns.keys()].sort((a, b) => a - b).map((n) => turns.get(n)!),
    call: {
      purposes: pick(c.purposes, PURPOSES),
      goal: has(GOALS, c.goal) ? c.goal : null,
      mood: has(MOODS, c.mood) ? c.mood : null,
      summary: clean(c.summary, MAX_SUMMARY),
    },
    missing: byNo.size - turns.size,
  };
}

type Span = [Issue, Set<number>, JudgedTurn[]];

/** 같은 문제가 이어진 차례 묶음 [(유형, 차례 번호들, 차례들)]. 불만 한 건이 묶음 하나다 */
export function spans(a: Judged): Span[] {
  const out: Span[] = [];
  for (const t of a.turns) {
    if (!t.issue) continue;
    const last = out[out.length - 1];
    if (last && last[0] === t.issue && last[2][last[2].length - 1].t === t.t - 1) {
      last[1].add(t.t);
      last[2].push(t);
    } else out.push([t.issue, new Set([t.t]), [t]]);
  }
  return out;
}

const overlaps = (a: Set<number>, b: Set<number>) => [...a].some((n) => b.has(n));

/** 다수결: 유형이 같고 차례가 겹치는 문제 묶음이 need판 이상에서 나온 것만 남긴다(먼저 나온 판의 차례 · 사유) */
export function vote(analyses: Judged[], need: number): Judged {
  const turns = new Map<number, JudgedTurn>();
  for (const a of analyses)
    for (const t of a.turns) if (!turns.has(t.t)) turns.set(t.t, { ...t, issue: null, why: '' });
  for (const [n, t] of turns)
    t.complain =
      analyses.filter((a) => a.turns.some((x) => x.t === n && x.complain)).length >= need;
  const runs = analyses.map(spans);
  const kept: [Issue, Set<number>][] = [];
  for (const runSpans of runs) {
    for (const [kind, nos, ts] of runSpans) {
      const seen = runs.filter((other) =>
        other.some(([k, n]) => k === kind && overlaps(nos, n)),
      ).length;
      if (seen < need || kept.some(([k, n]) => k === kind && overlaps(nos, n))) continue;
      kept.push([kind, nos]);
      for (const t of ts) {
        const turn = turns.get(t.t)!;
        if (!turn.issue) {
          turn.issue = kind;
          turn.why = t.why;
        }
      }
    }
  }
  return {
    turns: [...turns.keys()].sort((a, b) => a - b).map((n) => turns.get(n)!),
    call: analyses[0].call,
  };
}

// 장면 확인(2차): 1차 판정이 잡은 용건 인식 · 근거 없는 답변을 그 장면만 보여 주고 예/아니오로 다시 묻는다
const VERIFY: Issue[] = ['INTENT_FAILURE', 'UNGROUNDED_ANSWER'];
const VERIFY_CONTEXT = 3;
const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'why'],
  properties: { verdict: { type: 'string', enum: ['yes', 'no'] }, why: { type: 'string' } },
};

export interface RunResult extends Judged {
  votes: number;
  usage: Usage | null;
}

type Faq = { question?: unknown; answer?: unknown };

/** 통화 하나 판정: votes판을 동시에 판정해 다수결 + 장면 확인. 말이 없는 통화는 빈 판정.
 *  입력이 너무 길거나 성공한 판이 다수결에 모자라면 null(판정 안 함 · 실패는 호출한 쪽이 구분) */
export async function run(
  rec: CallRecord,
  ask: AskModel,
  faqs: Faq[] | null,
  votes = VOTES,
): Promise<RunResult | null> {
  if (!rec.turns.length)
    return {
      turns: [],
      call: { purposes: [], goal: null, mood: null, summary: '' },
      missing: 0,
      votes: 0,
      usage: null,
    };
  const text = describe(rec);
  if (chars(text).length > MAX_INPUT_CHARS) return null;
  const need = Math.min(NEED, votes);
  const judgeOnce = async () => {
    try {
      const { data, usage } = await ask(instructions(faqs), text, 'call_analysis', SCHEMA);
      return { ...check(data, rec), usage };
    } catch {
      return null;
    }
  };
  const done = (await Promise.all(Array.from({ length: votes }, judgeOnce))).filter(
    (a): a is Judged & { usage: Usage | null } => a !== null,
  );
  if (done.length < need) return null;
  const used = done.map((a) => a.usage).filter((u): u is Usage => u !== null);
  const out = vote(done, need);
  const scenes = spans(out)
    .filter(([kind]) => VERIFY.includes(kind))
    .map(([kind, nos]) => [kind, nos] as const);
  const checked = await Promise.all(
    scenes.map(async ([kind, nos]) => {
      const lo = Math.min(...nos);
      const hi = Math.max(...nos);
      const shown = new Set(
        Array.from({ length: hi + 2 - (lo - VERIFY_CONTEXT) }, (_, i) => lo - VERIFY_CONTEXT + i),
      );
      const input = `유형: ${kind}\n\n` + describe(rec, shown, nos);
      try {
        const { data, usage } = await ask(
          instructions(kind === 'UNGROUNDED_ANSWER' ? faqs : null, VERIFY_PROMPT),
          input,
          'confirm',
          VERIFY_SCHEMA,
        );
        const verdict =
          data && typeof data === 'object' ? (data as { verdict?: unknown }).verdict : undefined;
        return [verdict !== 'no', usage] as const;
      } catch {
        return [true, null] as const; // 확인 못 했다고 지우지 않는다
      }
    }),
  );
  scenes.forEach(([kind, nos], i) => {
    const [keep, usage] = checked[i];
    if (usage) used.push(usage);
    if (!keep)
      for (const t of out.turns)
        if (nos.has(t.t) && t.issue === kind) {
          t.issue = null;
          t.why = '';
        }
  });
  const usage = used.length
    ? (Object.fromEntries(
        (['input', 'cached', 'output', 'reasoning'] as const).map((k) => [
          k,
          used.reduce((s, u) => s + (u[k] ?? 0), 0),
        ]),
      ) as unknown as Usage)
    : null;
  return { ...out, missing: rec.turns.length - out.turns.length, votes: done.length, usage };
}
