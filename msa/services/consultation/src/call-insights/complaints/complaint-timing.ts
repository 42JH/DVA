// 녹음 시간 분석 (토큰 없음) — 통화가 끝난 뒤 저장된 녹음으로만 한다. 기준 구현: ai/call_analysis/timing.py
// 녹음은 한 채널 8kHz라 두 목소리가 섞여 있어 소리 크기로 말소리 구간만 찾고, 누가 말했는지는 대본 발화 시각으로 붙인다.
// 대본 offsetSeconds(초 단위): AI 발화는 말 시작 무렵, 고객 발화는 받아쓰기가 끝난 말 끝 무렵이다.

const FRAME_SEC = 0.02;
const ON_DB = 15; // 바닥 소음(하위 10%)보다 이만큼 크면 말소리
const JOIN_SEC = 0.35; // 이보다 짧은 끊김은 한 말소리로 잇는다(숨, 말 사이)
const MIN_SEC = 0.25; // 이보다 짧은 소리는 버린다(잡음)
export const SHOW_PAUSE = 2; // 판정 입력에 적는 침묵(초)
// 대본 시각으로 잰 공백: 옆 사람 말 같은 잡음이 녹음 침묵을 메우면 녹음으로는 못 잰다 → 글자 수로 어림해 이보다 길면 녹음 값 대신
const TEXT_GAP_MIN = 8;
const AI_CPS = 7;
const CUSTOMER_CPS = 5; // 말 속도(초당 글자): AI 음성 · 고객 말

export type Segment = [number, number];

/** 파이썬 round(x, n)과 같은 값 — 정확히 반인 값은 짝수 쪽으로 (JS toFixed는 올림이라 침묵 초가 달라짐) */
export function pyRound(x: number, n = 0): number {
  const s = Math.abs(x).toFixed(20);
  const [whole, frac] = s.split('.');
  if (frac[n] === '5' && /^0*$/.test(frac.slice(n + 1))) {
    const down = Number(`${whole}.${frac.slice(0, n) || '0'}`);
    const lastDigit = n === 0 ? Number(whole.slice(-1)) : Number(frac[n - 1]);
    const r = lastDigit % 2 === 0 ? down : down + 10 ** -n;
    return Number((Math.sign(x) * r).toFixed(n));
  }
  return Number(x.toFixed(n));
}

/** WAV(16비트 PCM) → 샘플(여러 채널이면 평균)과 샘플링 속도. PCM 16비트가 아니면 null */
export function readWav(
  wav: Buffer,
): { rate: number; samples: Float64Array } | null {
  if (
    wav.length < 12 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  )
    return null;
  let pos = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ' && body + 16 <= wav.length) {
      format = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      rate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || channels < 1 || rate < 1) return null;
      const end = Math.min(wav.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Float64Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++)
          sum += wav.readInt16LE(body + (i * channels + c) * 2);
        samples[i] = sum / channels;
      }
      return { rate, samples };
    }
    pos = body + size + (size % 2);
  }
  return null;
}

/** numpy.percentile(기본 linear)과 같은 계산 */
function percentile(values: Float64Array, q: number): number {
  const a = Float64Array.from(values).sort();
  const pos = (a.length - 1) * (q / 100);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const t = pos - lo;
  const diff = a[hi] - a[lo];
  return t >= 0.5 ? a[hi] - diff * (1 - t) : a[lo] + diff * t;
}

/** WAV → 말소리 구간 [(시작초, 끝초)]. PCM 16비트가 아니면 null (응답 지연을 정하지 않음) */
export function speechSegments(wav: Buffer): Segment[] | null {
  const read = readWav(wav);
  if (!read) return null;
  const { rate, samples } = read;
  const n = Math.trunc(rate * FRAME_SEC);
  if (n < 1 || samples.length < n) return [];
  const count = Math.floor(samples.length / n);
  const db = new Float64Array(count);
  for (let f = 0; f < count; f++) {
    let sq = 0;
    for (let i = f * n; i < (f + 1) * n; i++) sq += samples[i] * samples[i];
    db[f] = 20 * Math.log10(Math.sqrt(sq / n) + 1e-6);
  }
  const floor = percentile(db, 10) + ON_DB;
  const segs: Segment[] = [];
  for (let i = 0; i < count; i++) {
    if (!(db[i] > floor)) continue;
    const a = i * FRAME_SEC;
    const b = (i + 1) * FRAME_SEC;
    const last = segs[segs.length - 1];
    if (last && a - last[1] <= JOIN_SEC) last[1] = b;
    else segs.push([a, b]);
  }
  return segs
    .filter(([a, b]) => b - a >= MIN_SEC)
    .map(([a, b]) => [pyRound(a, 2), pyRound(b, 2)]);
}

/** [t0, t1] 안에서 가장 긴 침묵(초) — 말소리 구간 사이의 빈틈을 창에 맞춰 자른 길이 */
export function longestSilence(
  segs: Segment[],
  t0: number,
  t1: number,
): number {
  const edges: Segment[] = [
    [-1e9, t0],
    ...segs.filter((s) => s[1] > t0 && s[0] < t1),
    [t1, 1e9],
  ];
  let best = -Infinity;
  for (let i = 0; i + 1 < edges.length; i++)
    best = Math.max(
      best,
      Math.max(0, Math.min(edges[i + 1][0], t1) - Math.max(edges[i][1], t0)),
    );
  return pyRound(best, 1);
}

/** 대본만으로 어림한 두 발화 사이 공백(초). 발화 = [offsetSeconds, 고객인지, 글]. AI 시각은 말 시작, 고객 시각은 말 끝 무렵 */
export function textGap(
  prev: [number, boolean, string],
  cur: [number, boolean, string],
): number {
  const [a, aCust, aText] = prev;
  const [b, bCust, bText] = cur;
  const len = (s: string) => [...s.replace(/ /g, '')].length;
  const end = aCust ? a : a + len(aText) / AI_CPS;
  const start = bCust ? b - len(bText) / CUSTOMER_CPS : b;
  return pyRound(start - end, 1);
}

/** 발화 순서대로 offsetSeconds → 각 발화 앞 [침묵 초, 대본 어림인지](SHOW_PAUSE 이상만, 아니면 null) */
export function pauses(
  offsets: (number | null)[],
  segs: Segment[],
  said?: [boolean, string][],
): ([number, boolean] | null)[] {
  const out: ([number, boolean] | null)[] = offsets.map(() => null);
  for (let i = 1; i < offsets.length; i++) {
    const a = offsets[i - 1];
    const b = offsets[i];
    if (a === null || b === null || b < a) continue;
    let gap = longestSilence(segs, a, b + 1);
    let guessed = false;
    if (said) {
      const est = textGap([a, ...said[i - 1]], [b, ...said[i]]);
      if (est >= TEXT_GAP_MIN && est > gap) {
        gap = est;
        guessed = true;
      }
    }
    out[i] = gap >= SHOW_PAUSE ? [gap, guessed] : null;
  }
  return out;
}
