// 통화 불만 판정 워커(후처리) — 실제 DB로: 미판정 통화를 집고, 이벤트 · 발화 원문을 읽어 판정하고, call_analyses 불만 칸만 바꾼다.
// 모델은 가짜(OpenAI를 부르지 않음). 녹음은 없음 → 분석이 오래된 통화만 바로 판정(응답 지연 제외).
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, randomInt } = require('node:crypto');
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
const { applicationFixture } = require('./helpers/application.cjs');
const { ComplaintJudgeWorker } = require('../dist/call-insights/complaints/complaint-judge.worker');
const {
  ComplaintJudgeRepository,
} = require('../dist/call-insights/complaints/complaint-judge.repository');
const { ComplaintModelClient } = require('../dist/call-insights/complaints/complaint-model.client');
const f = applicationFixture();

const post = (path, body) =>
  fetch(f.base + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 통화 + AI 분석(불만 미판정) + 이벤트(발화 · 동작)를 AI API로 넣는다 */
const analysisInputs = new Map();
async function call(lines, { analysedMinutesAgo = 60 } = {}) {
  const providerCallId = 'rtc_complaint_' + randomUUID();
  const { id } = (
    await f.pool.query(
      "INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at) VALUES($1,$2,clock_timestamp()-interval '9 minutes',clock_timestamp()-interval '8 minutes',clock_timestamp()-interval '7 minutes') RETURNING call_session_seq AS id",
      [providerCallId, '010' + randomInt(10000000, 100000000)],
    )
  ).rows[0];
  const start = Date.now() - 480000;
  const events = [
    {
      kind: 'AI_ACTION',
      sec: 0,
      payload: { action: 'CUSTOMER_LOOKUP', summaryText: '등록 고객', orderSeq: null },
    },
    ...lines,
  ].map((e, i) => ({
    eventId: randomUUID(),
    eventOrder: i + 1,
    kind: e.kind,
    occurredAt: new Date(start + e.sec * 1000).toISOString(),
    offsetSeconds: e.sec,
    payload: e.payload,
  }));
  const sent = await post('/api/ai/calls/' + id + '/events', { providerCallId, events });
  assert.equal(sent.status, 204, await sent.clone().text());
  const analysisInput = {
    providerCallId,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + 60000).toISOString(),
    aiPersonaVersionSeq: null,
    repeatQuestionCount: 1,
    hasComplaint: null,
    complaints: [],
  };
  analysisInputs.set(id, analysisInput);
  const analysed = await post('/api/ai/calls/' + id + '/analysis', analysisInput);
  assert.equal(analysed.status, 204, await analysed.clone().text());
  await f.pool.query(
    'UPDATE call_analyses SET analysed_at=clock_timestamp()-make_interval(mins=>$2) WHERE call_session_seq=$1',
    [id, analysedMinutesAgo],
  );
  return id;
}
const say = (sec, order, speaker, text) => ({
  kind: 'UTTERANCE',
  sec,
  payload: { utteranceOrder: order, speaker, utteranceText: text, lastSentenceSeq: 1 },
});
const row = async (id) =>
  (
    await f.pool.query(
      'SELECT has_complaint AS "hasComplaint",complaints,complaint_attempts AS attempts,complaint_retry_at AS "retryAt",repeat_question_count AS repeats FROM call_analyses WHERE call_session_seq=$1',
      [id],
    )
  ).rows[0];

// 차례 1 = AI 인사(끊김) · 차례 2 = 고객 이름 + AI 다시 물음 · 차례 3 = 고객 불만
const LINES = [
  say(1, 1, 'AI', '안녕하세요, 보내시는 분 성함을'),
  say(4, 2, 'CUSTOMER', '홍길동이요'),
  say(6, 3, 'AI', '보내시는 분 성함을 말씀해 주세요.'),
  say(9, 4, 'CUSTOMER', '방금 말했잖아요'),
  say(11, 5, 'AI', '죄송합니다.'),
];
const turn = (t, extra = {}) => ({
  t,
  cust: [],
  given: [],
  ai: [],
  asked: [],
  basis: 'na',
  issue: 'none',
  why: '',
  quote: '',
  ...extra,
});
const REPLY = {
  turns: [
    turn(1),
    turn(2, {
      cust: ['answer'],
      given: ['sender_name'],
      ai: ['ask'],
      asked: ['sender_name'],
      issue: 'RECOGNITION_FAILURE',
      why: '이름을 다시 물음',
      quote: '보내시는 분 성함을 말씀해 주세요',
    }),
    turn(3, {
      cust: ['complain'],
      complain_quote: '방금 말했잖아요',
      complain_target: 'ai_service',
      complain_level: 'mild',
    }),
  ],
  call: { purposes: ['register'], goal: 'partial', mood: 'negative', summary: '이름을 두 번 말함' },
};

/** 이 통화만 집히게 — 같은 시험 DB의 다른 미판정 통화는 하루 뒤로 미룬다 */
const only = (id) =>
  f.pool.query(
    "UPDATE call_analyses SET complaint_retry_at=clock_timestamp()+interval '1 day' WHERE has_complaint IS NULL AND call_session_seq<>$1",
    [id],
  );

async function judgeAll(ask) {
  const worker = f.app.get(ComplaintJudgeWorker);
  f.app.get(ComplaintModelClient).ask = ask;
  await worker.fill();
  await Promise.allSettled([...worker.running]);
}

test('미판정 통화를 판정해 불만 칸만 바꾸고, 화면 · 상세가 그 값을 읽는다', async () => {
  const id = await call(LINES);
  await only(id);
  const originalHash = (
    await f.pool.query('SELECT payload_hash FROM call_analyses WHERE call_session_seq=$1', [id])
  ).rows[0].payload_hash;
  let asked = 0;
  await judgeAll(async (instructions, input, name) => {
    asked++;
    assert.match(input, /차례 2\n  고객: 홍길동이요/); // 발화 원문은 call_utterances에서
    return { data: name === 'confirm' ? { verdict: 'yes', why: '' } : REPLY, usage: null };
  });
  assert.ok(asked >= 3);
  const saved = await row(id);
  assert.equal(saved.hasComplaint, true);
  assert.deepEqual(saved.complaints.map((c) => c.type).sort(), [
    'DISSATISFACTION_EXPRESSION',
    'INFORMATION_RECOGNITION_ERROR',
    'INTERRUPTION',
  ]);
  assert.equal(
    saved.complaints.find((c) => c.type === 'DISSATISFACTION_EXPRESSION').target,
    'ai_service',
  );
  assert.equal(saved.complaints.find((c) => c.type === 'DISSATISFACTION_EXPRESSION').level, 'mild');
  for (const complaint of saved.complaints)
    assert.deepEqual(
      Object.keys(complaint).sort(),
      ['type', 'target', 'level', 'evidenceText', 'offsetSeconds', 'utteranceOrders'].sort(),
    );
  assert.equal(
    (await f.pool.query('SELECT payload_hash FROM call_analyses WHERE call_session_seq=$1', [id]))
      .rows[0].payload_hash,
    originalHash,
  );
  const replay = await post('/api/ai/calls/' + id + '/analysis', analysisInputs.get(id));
  assert.equal(replay.status, 204, await replay.text());
  assert.equal(saved.repeats, 1); // AI가 보낸 되묻기 수는 그대로
  assert.equal(saved.retryAt, null);
  const detail = await f.get('/api/calls/' + id);
  assert.equal(detail.status, 200);
  const analysis = (await detail.json()).data.analysis;
  assert.equal(analysis.hasComplaint, true);
  assert.equal(analysis.complaints.length, 3);
  // 다시 돌려도 판정이 끝난 통화는 집지 않는다
  await judgeAll(async () => assert.fail('판정한 통화를 다시 집음'));
});

test('모델 장애는 3번까지 다시 시도하고, 그 뒤에는 미판정으로 남긴다', async () => {
  const id = await call(LINES);
  await only(id);
  for (let i = 1; i <= 3; i++) {
    await f.pool.query(
      'UPDATE call_analyses SET complaint_retry_at=NULL WHERE call_session_seq=$1',
      [id],
    );
    await judgeAll(async () => {
      throw new Error('down');
    });
    const r = await row(id);
    assert.equal(r.hasComplaint, null);
    assert.equal(r.attempts, i);
    assert.ok(r.retryAt > new Date());
  }
  await f.pool.query('UPDATE call_analyses SET complaint_retry_at=NULL WHERE call_session_seq=$1', [
    id,
  ]);
  await judgeAll(async () => assert.fail('3번 실패한 통화를 다시 집음'));
  assert.equal((await row(id)).attempts, 3);
});

test('녹음이 아직 없으면 분석 뒤 30분까지 기다리고, 시도 수는 쓰지 않는다', async () => {
  const id = await call(LINES, { analysedMinutesAgo: 1 });
  await only(id);
  await judgeAll(async () => assert.fail('녹음을 기다려야 함'));
  const r = await row(id);
  assert.equal(r.hasComplaint, null);
  assert.equal(r.attempts, 0);
  assert.ok(r.retryAt > new Date());
});

test('두 워커가 같은 통화를 집지 않는다', async () => {
  const id = await call(LINES);
  const repo = f.app.get(ComplaintJudgeRepository);
  await only(id);
  const [a, b] = await Promise.all([repo.claim(), repo.claim()]);
  assert.deepEqual([a?.id, b?.id].filter(Boolean), [id]);
});

test('발화 미수집 분석은 집지 않고 늦게 발화가 도착하면 판정한다', async () => {
  const id = await call([]);
  await only(id);
  assert.equal(await f.app.get(ComplaintJudgeRepository).claim(), undefined);
  assert.equal((await row(id)).hasComplaint, null);
  assert.equal((await row(id)).attempts, 0);
  const { provider_call_id: providerCallId } = (
    await f.pool.query('SELECT provider_call_id FROM call_sessions WHERE call_session_seq=$1', [id])
  ).rows[0];
  const response = await post('/api/ai/calls/' + id + '/events', {
    providerCallId,
    events: LINES.map((line, index) => ({
      eventId: randomUUID(),
      eventOrder: index + 2,
      kind: line.kind,
      occurredAt: new Date(Date.now() - 480000 + line.sec * 1000).toISOString(),
      offsetSeconds: line.sec,
      payload: line.payload,
    })),
  });
  assert.equal(response.status, 204, await response.clone().text());
  await judgeAll(async () => ({ data: REPLY, usage: null }));
  assert.equal((await row(id)).hasComplaint, true);
});

test('조회는 책임·강도·참고 표시를 제공하고 저장된 점검용 필드를 노출하지 않는다', async () => {
  const id = await call(LINES);
  const found = [
    { type: 'DISSATISFACTION_EXPRESSION', target: 'delivery_other', level: 'explicit' },
    { type: 'DISSATISFACTION_EXPRESSION', target: 'unknown', level: 'unknown' },
    { type: 'DISSATISFACTION_EXPRESSION' },
    { type: 'UNSUPPORTED_ANSWER', target: 'ai_service', level: 'mild' },
  ].map((c) => ({
    ...c,
    evidenceText: '합성 근거',
    offsetSeconds: 9,
    utteranceOrders: [4],
    dropped: { quote: 1 },
    candidates: [],
  }));
  await f.pool.query(
    'UPDATE call_analyses SET has_complaint=true,complaints=$2::jsonb WHERE call_session_seq=$1',
    [id, JSON.stringify(found)],
  );
  const response = await f.get('/api/calls/' + id);
  assert.equal(response.status, 200);
  const analysis = (await response.json()).data.analysis;
  assert.deepEqual(
    analysis.complaints.map((c) => [c.target, c.level, c.referenceOnly]),
    [
      ['delivery_other', 'explicit', false],
      [null, null, false],
      [null, null, false],
      [null, null, true],
    ],
  );
  assert.ok(
    analysis.complaints.every(
      (c) => !Object.hasOwn(c, 'dropped') && !Object.hasOwn(c, 'candidates'),
    ),
  );
});
