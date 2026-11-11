// 코드로 확정하는 불만(토큰 없음) + 판정 결과 → 백엔드 불만 모양. 기준 구현: ai/call_analysis/facts.py · extract.py · server.py
// - 응답 지연: AI가 말할 차례의 침묵이 녹음으로 10초 이상, 또는 3초 이상이고 고객이 기다림을 드러냄
// - 정보 인식 오류(코드): 고객이 부른 번호와 AI 복창 번호가 다름 · 인사에서 부른 이름 · 등록 출발지를 다시 물음
// - 말 끊김: AI 말이 문장 중간에 잘리고 고객이 바로 말함(Utterance.cut)
import { CallComplaintType } from '../call-insights.types';
import { CallRecord, Judged, digitsOf } from './complaint-judge';
import { longestSilence, textGap } from './complaint-timing';

const WAIT_AI =
  /잠시만|확인해 ?(볼|보겠|드릴)|기다려|확인 중|확인하고 있|진행하겠|알아볼게|찾아볼게|정리해 드릴/u;
const WAIT_CUST =
  /여보세요|멈췄|대답|들으셨|들리세요|언제까지|얼마나 걸|렉|끊긴|계세요|왜 말이 없|됐나요|됐어요\?|접수됐/u;
const AI_HANDOFF = /(\?|까요|나요|가요|세요|주세요|주시겠어요|있으신가요)[^\p{L}\p{N}_]*$/u;
const SLOW_LONG = 10;
const SLOW_SHORT = 3;
const ASK_SENDER_NAME = /보내(시는|는) 분 성함/u;
const ASK_ORIGIN = /(보내(시)?는 곳|발송) ?주소/u;
const ASK_VERB = /알려|말씀|부탁|여쭤|어떻게 되/u;
const GREET_NAME = /[가-힣]{2,4} ?(고객)?님/u;
const GREET_ORIGIN = /에서 보내시는/u;
const CHANGED = /바꾸|바꿀|다른|변경|아니|새로/u;
const NAME_CHANGE =
  /(이름|성함|보내는 ?(사람|분)).{0,12}(바꾸|바꿀|바꿔|변경|다른)|(바꾸|바꿀|바꿔|변경).{0,8}(이름|성함)/u;
const ORIGIN_CHANGE =
  /다른 ?(데|곳)에서|딴 ?데서|(보내는 ?(곳|주소)|출발).{0,12}(바꾸|바꿀|바꿔|변경|다른)/u;
const SENTENCES = /(?<=[.?!])\s*|(?<=[다요까죠])\.?\s+/u;

/** 응답 지연 [(앞 발화 번호, 뒤 발화 번호)]. 녹음 말소리 구간이 없으면 정하지 않는다 */
export function slowTurns(rec: CallRecord): [number, number][] {
  if (!rec.speech) return [];
  const us = rec.turns.flatMap((t) => t.utterances);
  const hits: [number, number][] = [];
  let aiSaid = '';
  let run: number[] = [0];
  for (let i = 0; i + 1 < us.length; i++) {
    const a = us[i];
    const b = us[i + 1];
    if (!a.customer) aiSaid += ' ' + a.text;
    if (a.offset === null || b.offset === null || b.offset < a.offset) continue;
    const audio = longestSilence(rec.speech, a.offset, b.offset + 1);
    const est = textGap([a.offset, a.customer, a.text], [b.offset, b.customer, b.text]);
    const waiting =
      WAIT_AI.test(aiSaid) &&
      (WAIT_AI.test([...a.text].slice(-15).join('')) || !AI_HANDOFF.test(a.text));
    const aiTurn = a.customer || !b.customer || waiting;
    if (b.customer) run = [...(a.customer ? run : []), Math.max(audio, est)];
    if (
      aiTurn &&
      (audio >= SLOW_LONG ||
        (b.customer && WAIT_CUST.test(b.text) && Math.max(...run) >= SLOW_SHORT))
    )
      hits.push([a.order, b.order]);
    if (b.customer) aiSaid = '';
  }
  return hits;
}

/** 말 속의 마지막 번호(0으로 시작하는 9자리 이상) */
function phoneOf(text: string): string | null {
  const runs: string[] = [];
  let cur = '';
  for (const tok of text.split(/[\s,.·-]+/u)) {
    const d = tok ? digitsOf(tok) : null;
    if (d) cur += d;
    else if (cur) {
      runs.push(cur);
      cur = '';
    }
  }
  runs.push(cur);
  const phones = runs.filter((r) => [...r].length >= 9 && r.startsWith('0'));
  return phones.length ? phones[phones.length - 1] : null;
}

/** 정보 인식 오류 [(발화 번호, 끝 발화 번호, 사유)] */
export function infoErrors(rec: CallRecord): [number, number, string][] {
  const us = rec.turns.flatMap((t) => t.utterances);
  const out: [number, number, string][] = [];
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    const said =
      u.customer && ![...'십백천만'].some((w) => u.text.includes(w)) ? phoneOf(u.text) : null;
    if (!said) continue;
    for (const v of us.slice(i + 1, i + 4)) {
      if (v.customer) break;
      const back = phoneOf(v.text);
      if (back && !(back.startsWith(said) || said.startsWith(back))) {
        out.push([u.order, v.order, '고객이 부른 번호와 다르게 복창함']);
        break;
      }
    }
  }
  const first = us.length && !us[0].customer ? us[0] : null;
  const reply =
    rec.turns.length > 1
      ? rec.turns[1].utterances
          .filter((x) => x.customer)
          .map((x) => x.text)
          .join(' ')
      : '';
  const checks: [RegExp, boolean, string, RegExp][] = [
    [
      ASK_SENDER_NAME,
      !!first && GREET_NAME.test(first.text),
      '인사에서 부른 이름을 다시 물음',
      NAME_CHANGE,
    ],
    [
      ASK_ORIGIN,
      !!first && GREET_ORIGIN.test(first.text),
      '인사에서 말한 등록 출발지를 다시 물음',
      ORIGIN_CHANGE,
    ],
  ];
  for (const [ask, known, why, field] of checks) {
    if (!known) continue;
    for (let k = 1; k < us.length; k++) {
      const u = us[k];
      const before =
        reply +
        ' ' +
        us
          .slice(Math.max(0, k - 2), k)
          .filter((x) => x.customer)
          .map((x) => x.text)
          .join(' ');
      const changed =
        CHANGED.test(before) || us.slice(1, k).some((x) => x.customer && field.test(x.text));
      const asked = u.text
        .split(SENTENCES)
        .some(
          (sentence) =>
            ask.test(sentence) && ASK_VERB.test(sentence) && !sentence.includes('성함은'),
        );
      if (!u.customer && asked && !changed) {
        out.push([u.order, u.order, why]);
        break;
      }
    }
  }
  return out;
}

const MAX_COMPLAINTS = 20; // 백엔드 call_analyses 상한
const MERGE_GAP = 1; // 같은 문제가 이만큼 차례 안에 다시 나오면 한 건
const DEFAULT_REASON: Record<string, string> = {
  RECOGNITION_FAILURE: '고객이 준 정보를 잘못 받음',
  INTENT_FAILURE: '고객의 질문·요청을 다르게 받음',
  UNGROUNDED_ANSWER: 'FAQ · 업무 규칙과 다르게 안내함',
  SLOW_RESPONSE: 'AI 응답이 늦어 고객이 기다림',
  INTERRUPTION: '고객이 끼어들어 AI 말이 중간에 끊김',
  CUSTOMER_CONFUSION: '고객이 AI 말을 못 알아들음',
  FRUSTRATION: '고객이 불만을 드러냄',
};
// 판정 유형 → 백엔드 불만 유형(화면 6유형). 고객 되물음(CUSTOMER_CONFUSION)은 집계에서 뺀다
const BACKEND_TYPE: Record<string, CallComplaintType> = {
  RECOGNITION_FAILURE: 'INFORMATION_RECOGNITION_ERROR',
  INTENT_FAILURE: 'INTENT_RECOGNITION_ERROR',
  UNGROUNDED_ANSWER: 'UNSUPPORTED_ANSWER',
  SLOW_RESPONSE: 'SLOW_RESPONSE',
  INTERRUPTION: 'INTERRUPTION',
  FRUSTRATION: 'DISSATISFACTION_EXPRESSION',
};

export interface Complaint {
  type: string;
  evidenceText: string;
  offsetSeconds: number | null;
  utteranceOrders: number[];
  target?: string | null;
  level?: string | null;
}

type Mark = {
  t: number;
  issue: string | null;
  why: string;
  complain_target?: string | null;
  complain_level?: string | null;
  complain_quote?: string;
};

/** 문제가 있는 차례를 불만으로. 유형마다 같은 문제가 이어지거나 MERGE_GAP 차례 안에 다시 나오면 한 건으로 합친다 */
export function complaints(analysis: Judged, rec: CallRecord): Complaint[] {
  const byNo = new Map(rec.turns.map((t) => [t.no, t]));
  const marks = new Map<string, Mark[]>();
  const add = (kind: string, m: Mark) => {
    if (!marks.has(kind)) marks.set(kind, []);
    marks.get(kind)!.push(m);
  };
  for (const t of analysis.turns) {
    if (t.issue) add(t.issue, t);
    if (t.complain) add('FRUSTRATION', t);
  }
  const turnOf = new Map(
    rec.turns.flatMap((t) => t.utterances.map((u) => [u.order, t.no] as const)),
  );
  for (const t of rec.turns)
    if (t.utterances.some((u) => u.cut))
      add('INTERRUPTION', { t: t.no, issue: 'INTERRUPTION', why: '' });
  for (const [, b] of slowTurns(rec))
    add('SLOW_RESPONSE', { t: turnOf.get(b)!, issue: 'SLOW_RESPONSE', why: '' });
  for (const [a, , why] of infoErrors(rec))
    add('RECOGNITION_FAILURE', { t: turnOf.get(a)!, issue: 'RECOGNITION_FAILURE', why });
  for (const [kind, list] of marks) {
    const seen = new Map<number, Mark>();
    for (const m of list) if (!seen.has(m.t)) seen.set(m.t, m);
    marks.set(
      kind,
      [...seen.keys()].sort((a, b) => a - b).map((n) => seen.get(n)!),
    );
  }
  const out: [number, Complaint][] = [];
  for (const [kind, list] of marks) {
    let last: number | null = null;
    for (const m of list) {
      const orders = byNo.get(m.t)!.utterances.map((u) => u.order);
      if (last !== null && m.t - last <= MERGE_GAP + 1) {
        const between: number[] = [];
        for (let n = last + 1; n < m.t; n++)
          for (const u of byNo.get(n)?.utterances ?? []) between.push(u.order);
        out[out.length - 1][1].utteranceOrders.push(...between, ...orders);
        if (kind === 'FRUSTRATION' && m.complain_level === 'explicit')
          out[out.length - 1][1].level = 'explicit';
      } else {
        const why = kind === 'FRUSTRATION' ? m.complain_quote : m.issue === kind ? m.why : '';
        out.push([
          m.t,
          {
            type: kind,
            evidenceText: why || DEFAULT_REASON[kind],
            offsetSeconds: byNo.get(m.t)!.utterances[0].offset,
            utteranceOrders: orders,
            ...(kind === 'FRUSTRATION'
              ? { target: m.complain_target ?? null, level: m.complain_level ?? null }
              : {}),
          },
        ]);
      }
      last = m.t;
    }
  }
  return out
    .map((x, i) => [x, i] as const)
    .sort((a, b) => a[0][0] - b[0][0] || a[1] - b[1])
    .map(([x]) => x[1])
    .slice(0, MAX_COMPLAINTS);
}

/** 백엔드 call_analyses에 저장할 모양 — 화면 6유형만, 발화 순번은 겹침 없이 오름차순(백엔드 저장 규칙) */
export function backendComplaints(
  analysis: Judged,
  rec: CallRecord,
): {
  hasComplaint: boolean;
  complaints: {
    type: CallComplaintType;
    evidenceText: string;
    offsetSeconds: number | null;
    utteranceOrders: number[];
    target: string | null;
    level: string | null;
  }[];
} {
  const found = complaints(analysis, rec)
    .filter((c) => c.type in BACKEND_TYPE)
    .map((c) => ({
      type: BACKEND_TYPE[c.type],
      target: c.type === 'FRUSTRATION' ? (c.target ?? null) : null,
      level: c.type === 'FRUSTRATION' ? (c.level ?? null) : null,
      evidenceText: c.evidenceText,
      offsetSeconds: c.offsetSeconds === null ? null : Math.max(0, Math.trunc(c.offsetSeconds)),
      utteranceOrders: [...new Set(c.utteranceOrders)].sort((a, b) => a - b),
    }));
  return { hasComplaint: found.length > 0, complaints: found };
}
