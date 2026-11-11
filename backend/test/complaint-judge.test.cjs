// 불만 판정 TS 이식본이 파이썬 기준 구현(ai/call_analysis)과 같은 결과를 내는지 — 기준 구현의 테스트를 돌리며 기록한 입력 · 출력을 다시 넣어 본다.
// 정답 파일: fixtures/complaint-parity.json.gz (테스트의 가짜 데이터만, 개인정보 없음). 판정 규칙을 바꾸면 파이썬에서 다시 기록한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { join } = require('node:path');
const judge = require('../dist/call-insights/complaints/complaint-judge');
const extract = require('../dist/call-insights/complaints/complaint-extract');
const timing = require('../dist/call-insights/complaints/complaint-timing');
const { ComplaintJudgeWorker } = require('../dist/call-insights/complaints/complaint-judge.worker');

const { cases } = JSON.parse(
  gunzipSync(readFileSync(join(__dirname, 'fixtures', 'complaint-parity.json.gz'))).toString(
    'utf8',
  ),
);
const rec = (src) => {
  const r = judge.fromEvents(src.events, '', src.speech);
  src.downs?.forEach((down, i) => (r.turns[i].down = down)); // 기준 구현 테스트가 만든 뒤 바꾼 장애 구간
  return r;
};
const set = (v) => (v === null ? undefined : new Set(v));
const of = (fn) => cases.filter((c) => c.fn === fn);
const plain = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      item instanceof Set ? [...item].sort((a, b) => a - b) : item,
    ),
  );
const withDispute = async (values, action) => {
  const previous = [...judge.DISPUTE];
  judge.DISPUTE.splice(0, judge.DISPUTE.length, ...values);
  try {
    return await action();
  } finally {
    judge.DISPUTE.splice(0, judge.DISPUTE.length, ...previous);
  }
};

test('파이썬 기준 구현에서 기록한 사례가 있다', () => {
  for (const fn of [
    'describe',
    'check',
    'vote',
    'run',
    'complaints',
    'slow_turns',
    'info_errors',
    'spoken_phone_ok',
    'speech_segments',
    'pauses',
  ])
    assert.ok(of(fn).length > 0, fn);
});

test('차례 나누기 · 모델 입력 글이 같다', () => {
  for (const c of of('describe'))
    assert.equal(judge.describe(rec(c.rec), set(c.only), set(c.mark)), c.out);
});

test('모델 결과 검사가 같다', () => {
  for (const c of of('check')) assert.deepEqual(judge.check(c.raw, rec(c.rec), c.sources), c.out);
});

test('다수결이 같다', async () => {
  for (const c of of('vote'))
    await withDispute(c.dispute, () =>
      assert.deepEqual(plain(judge.vote(structuredClone(c.analyses), c.need)), c.out),
    );
});

test('업무 규칙·FAQ 지시문이 기준 원문과 같다', () => {
  const prompts = require('../dist/call-insights/complaints/complaint-prompts');
  for (const c of of('references')) assert.equal(judge.references(c.faqs, c.rules), c.out);
  for (const c of of('instructions'))
    assert.equal(
      judge.instructions(
        c.faqs,
        c.prompt === 'verify.md' ? prompts.VERIFY_PROMPT : prompts.JUDGE_PROMPT,
        c.rules,
      ),
      c.out,
    );
});

test('코드로 정하는 응답 지연 · 정보 인식 오류 · 번호 자릿수가 같다', () => {
  for (const c of of('slow_turns')) assert.deepEqual(extract.slowTurns(rec(c.rec)), c.out);
  for (const c of of('info_errors')) assert.deepEqual(extract.infoErrors(rec(c.rec)), c.out);
  for (const c of of('spoken_phone_ok')) assert.equal(judge.spokenPhoneOk(c.text), c.out, c.text);
});

test('불만 묶기가 같다', () => {
  for (const c of of('complaints'))
    assert.deepEqual(extract.complaints(c.analysis, rec(c.rec)), c.out);
});

test('녹음 침묵 계산이 같다 (파이썬 반올림 포함)', () => {
  for (const c of of('longest_silence'))
    assert.equal(timing.longestSilence(c.segs, c.t0, c.t1), c.out);
  for (const c of of('text_gap')) assert.equal(timing.textGap(c.prev, c.cur), c.out);
  for (const c of of('pauses')) assert.deepEqual(timing.pauses(c.offsets, c.segs, c.said), c.out);
  assert.equal(timing.pyRound(2.25, 1), 2.2);
  assert.equal(timing.pyRound(2.5, 0), 2);
  assert.equal(timing.pyRound(3.5, 0), 4);
  assert.equal(timing.pyRound(-2.25, 1), -2.2);
  assert.equal(timing.pyRound(2.35, 1), 2.4);
});

test('녹음 말소리 구간이 같다', () => {
  for (const c of of('speech_segments'))
    assert.deepEqual(timing.speechSegments(Buffer.from(c.wav, 'base64')), c.out);
  assert.equal(timing.speechSegments(Buffer.from('not a wav')), null);
});

test('판정 흐름(3판 다수결 · 장면 확인 · 실패)이 같다 — 같은 순서로 같은 가짜 모델 답을 넣음', async () => {
  for (const c of of('run')) {
    let calls = 0;
    const requests = [];
    const ask = async (instructions, input, name, schema) => {
      requests.push({ instructions, input, name, schema });
      calls += 1;
      const reply = c.replies[Math.min(calls, c.replies.length) - 1];
      if (reply.error) throw new Error(reply.error);
      return {
        data: JSON.parse(reply.text),
        usage: { input: 900, cached: 0, output: 300, reasoning: 200 },
      };
    };
    await withDispute(c.dispute, async () => {
      assert.deepEqual(plain(await judge.run(rec(c.rec), ask, c.faqs, c.votes)), c.out);
      assert.deepEqual(requests, c.requests);
    });
  }
});

test('백엔드 저장 모양: 화면 6유형만, 발화 순번은 겹침 없이 오름차순', () => {
  const r = judge.fromEvents([
    {
      kind: 'UTTERANCE',
      occurredAt: '2026-11-02T10:00:01+09:00',
      offsetSeconds: 1,
      payload: { utteranceOrder: 1, speaker: 'AI', utteranceText: '보내시는 분 성함을' },
    },
    {
      kind: 'UTTERANCE',
      occurredAt: '2026-11-02T10:00:03+09:00',
      offsetSeconds: 3,
      payload: { utteranceOrder: 2, speaker: 'CUSTOMER', utteranceText: '네? 뭐라고요' },
    },
  ]);
  const analysis = {
    turns: [
      {
        t: 1,
        complain: false,
        cust: [],
        given: [],
        ai: [],
        asked: [],
        basis: 'na',
        issue: null,
        why: '',
      },
      {
        t: 2,
        complain: true,
        complain_target: 'ai_service',
        complain_level: 'mild',
        complain_quote: '네? 뭐라고요',
        cust: ['ask_back', 'complain'],
        given: [],
        ai: [],
        asked: [],
        basis: 'na',
        issue: 'CUSTOMER_CONFUSION',
        why: '되물음',
      },
    ],
    call: { purposes: [], goal: null, mood: null, summary: '' },
  };
  const out = extract.backendComplaints(analysis, r);
  assert.equal(out.hasComplaint, true);
  assert.deepEqual(out.complaints.map((c) => c.type).sort(), [
    'DISSATISFACTION_EXPRESSION',
    'INTERRUPTION',
  ]);
  for (const c of out.complaints)
    assert.deepEqual(
      c.utteranceOrders,
      [...new Set(c.utteranceOrders)].sort((a, b) => a - b),
    );
});

test('모델 응답: 메시지의 output_text를 이어 붙여 JSON으로 · 토큰 · 빈 응답은 실패', () => {
  const { parse } = require('../dist/call-insights/complaints/complaint-model.client');
  const body = {
    output: [
      { type: 'reasoning', content: [] },
      {
        type: 'message',
        content: [
          { type: 'output_text', text: '{"verdict":' },
          { type: 'output_text', text: '"no","why":"x"}' },
        ],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
  };
  assert.deepEqual(parse(body), {
    data: { verdict: 'no', why: 'x' },
    usage: { input: 10, cached: 4, output: 5, reasoning: 3 },
  });
  assert.throws(() => parse({ output: [] }));
  assert.throws(() =>
    parse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'not json' }] }] }),
  );
});

test('판정 키는 선택 · 동시 판정 수는 1~4', () => {
  const { validateEnvironment } = require('../dist/config/environment');
  const base = {
    NODE_ENV: 'test',
    DB_HOST: 'db',
    DB_USER: 'u',
    DB_PASSWORD: 'p',
    DB_NAME: 'n',
    AI_AGENT_URL: 'http://ai.invalid:8000',
  };
  const env = validateEnvironment(base);
  assert.equal(env.CALL_ANALYSIS_OPENAI_API_KEY, undefined);
  assert.equal(env.CALL_ANALYSIS_CONCURRENCY, 2);
  assert.equal(
    validateEnvironment({ ...base, CALL_ANALYSIS_OPENAI_API_KEY: 'sk-test-only-key-0123456789' })
      .CALL_ANALYSIS_OPENAI_API_KEY,
    'sk-test-only-key-0123456789',
  );
  assert.throws(
    () => validateEnvironment({ ...base, CALL_ANALYSIS_OPENAI_API_KEY: 'short' }),
    /CALL_ANALYSIS_OPENAI_API_KEY/,
  );
  assert.throws(
    () => validateEnvironment({ ...base, CALL_ANALYSIS_CONCURRENCY: '9' }),
    /CALL_ANALYSIS_CONCURRENCY/,
  );
});

function testWorker(repository) {
  const worker = new ComplaintJudgeWorker(
    repository,
    { ask: async () => assert.fail('외부 모델 호출 금지') },
    { get: (key) => ({ AWS_REGION: 'ap-northeast-2', CALL_ANALYSIS_CONCURRENCY: 1 })[key] },
  );
  worker.logger = { log() {}, warn() {} };
  return worker;
}

test('발화 입력이 없으면 불만 없음으로 확정하지 않고 미판정으로 대기한다', async () => {
  let claimed = false;
  const saved = [],
    retries = [];
  const worker = testWorker({
    async claim() {
      if (claimed) return;
      claimed = true;
      return { id: 1, attempt: 1, analysedAt: new Date(Date.now() - 3600000) };
    },
    async inputs() {
      return { events: [], faqs: [], recordingKey: null };
    },
    async save(...args) {
      saved.push(args);
    },
    async retryLater(...args) {
      retries.push(args);
    },
  });
  try {
    await worker.fill();
    await Promise.allSettled([...worker.running]);
    assert.deepEqual(saved, []);
    assert.deepEqual(retries, [[1, 5, false]]);
  } finally {
    await worker.onModuleDestroy();
    worker.onApplicationShutdown();
  }
});

test('집기가 지연되어 fill이 겹쳐도 설정한 동시 판정 수를 지킨다', async () => {
  const claims = [];
  const worker = testWorker({ claim: () => new Promise((resolve) => claims.push(resolve)) });
  let finish;
  const blocked = new Promise((resolve) => {
    finish = resolve;
  });
  worker.judge = async () => blocked;
  try {
    const first = worker.fill(),
      second = worker.fill();
    claims.forEach((resolve, i) => resolve({ id: i + 1, attempt: 1, analysedAt: new Date(0) }));
    await Promise.all([first, second]);
    assert.equal(worker.running.size, 1);
  } finally {
    finish();
    await worker.onModuleDestroy();
    worker.onApplicationShutdown();
  }
});

test('one call builds shared instructions once while retaining independent votes and usage', async () => {
  let reads = 0;
  const faq = {
    get question() {
      reads++;
      return 'Synthetic question';
    },
    answer: 'Synthetic answer',
  };
  const record = judge.fromEvents(
      [
        {
          kind: 'UTTERANCE',
          occurredAt: '2026-11-01T00:00:00Z',
          offsetSeconds: 0,
          payload: { utteranceOrder: 1, speaker: 'CUSTOMER', utteranceText: '요금이 궁금합니다.' },
        },
      ],
      '',
      null,
    ),
    requests = [];
  const output = await judge.run(
    record,
    async (...args) => {
      requests.push(args);
      return {
        data: {
          turns: [],
          call: { purposes: ['inquiry'], goal: 'achieved', mood: 'neutral', summary: 'Synthetic' },
        },
        usage: { input: 3, cached: 0, output: 2, reasoning: 1 },
      };
    },
    [faq],
  );
  assert.equal(reads, 1);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(requests[1], requests[2]);
  assert.equal(output.votes, 3);
  assert.deepEqual(output.usage, { input: 9, cached: 0, output: 6, reasoning: 3 });
  const newer = [];
  await judge.run(
    record,
    async (...args) => {
      newer.push(args);
      return { data: { turns: [], call: {} }, usage: null };
    },
    [{ question: 'Changed question', answer: 'Changed answer' }],
  );
  assert.notEqual(requests[0][0], newer[0][0]);
  assert.equal(
    await judge.run(record, async () => {
      throw new Error('must not call provider');
    }, [
      {
        get question() {
          throw new Error('malformed FAQ');
        },
        answer: 'unused',
      },
    ]),
    null,
  );
});

test('고객 인용은 번호 마스킹 전에 확인하고 저장값에는 판정 결과만 남긴다', () => {
  const r = judge.fromEvents([
    {
      kind: 'UTTERANCE',
      occurredAt: '2026-11-02T00:00:01Z',
      offsetSeconds: 1,
      payload: {
        utteranceOrder: 1,
        speaker: 'CUSTOMER',
        utteranceText: '요금 12345원이 너무 비싸네요',
      },
    },
  ]);
  const raw = {
    turns: [
      {
        t: 1,
        cust: ['complain'],
        complain_quote: '요금 12345원이 너무 비싸네요',
        complain_target: 'price_policy',
        complain_level: 'bogus',
        issue: 'none',
      },
    ],
  };
  const checked = judge.check(raw, r);
  assert.equal(checked.turns[0].complain, true);
  assert.equal(checked.turns[0].complain_level, 'mild');
  const saved = extract.backendComplaints(checked, r);
  assert.deepEqual(saved.complaints, [
    {
      type: 'DISSATISFACTION_EXPRESSION',
      target: 'price_policy',
      level: 'mild',
      evidenceText: '요금 ***원이 너무 비싸네요',
      offsetSeconds: 1,
      utteranceOrders: [1],
    },
  ]);
  assert.equal(
    judge.check({ turns: [{ ...raw.turns[0], complain_quote: '요금 ***원이 너무 비싸네요' }] }, r)
      .turns[0].complain,
    false,
  );
  assert.equal(Object.hasOwn(saved, 'dropped'), false);
  assert.equal(Object.hasOwn(saved, 'candidates'), false);
});
