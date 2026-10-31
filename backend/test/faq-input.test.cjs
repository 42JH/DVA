require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/delivery-faq.json');
const { validateFaqSeed } = require('../dist/faqs/faq-seed');
const {
  AiFaqQueryDto,
  AdminFaqQueryDto,
  CreateFaqDto,
  DeleteFaqsDto,
  UpdateFaqDto,
} = require('../dist/faqs/dto/faq-request.dto');
const { CreateFaqPipe } = require('../dist/faqs/create-faq.pipe');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const pipe = createValidationPipe();

test('FAQ create and update both require category, question and answer, with exactly the ten screenshot categories', async () => {
  const categories = [
    '접수',
    '수거 일정',
    '물품·박스',
    '포장·파손',
    '배송·운송장',
    '주소',
    '변경·취소',
    '요금·결제',
    '이용 안내',
    '기타',
  ];
  for (const metatype of [CreateFaqDto, UpdateFaqDto]) {
    for (const category of categories) {
      const input = { category, question: ' 질문 원문\n', answer: ' 답변 원문\n' };
      assert.deepEqual(
        JSON.parse(JSON.stringify(await pipe.transform(input, { type: 'body', metatype }))),
        input,
      );
    }
    const input = { category: '접수', question: '질문', answer: '답변' };
    for (const field of Object.keys(input)) {
      const value = { ...input };
      delete value[field];
      await assert.rejects(() => pipe.transform(value, { type: 'body', metatype }), {
        status: 400,
      });
    }
    for (const category of ['전체', '접수 ', 'UNKNOWN', null, 1, ['접수']])
      await assert.rejects(
        () => pipe.transform({ ...input, category }, { type: 'body', metatype }),
        { status: 400 },
      );
  }
});

test('category filtering is administrator-only and does not extend AI query fields', async () => {
  assert.equal(
    (await pipe.transform({ category: '주소' }, { type: 'query', metatype: AdminFaqQueryDto }))
      .category,
    '주소',
  );
  for (const metatype of [AdminFaqQueryDto, AiFaqQueryDto])
    for (const category of ['전체', 'UNKNOWN', ['접수', '주소']])
      await assert.rejects(() => pipe.transform({ category }, { type: 'query', metatype }), {
        status: 400,
      });
  await assert.rejects(
    () => pipe.transform({ category: '접수' }, { type: 'query', metatype: AiFaqQueryDto }),
    { status: 400 },
  );
});

test('AI FAQ filtering validates a bounded, unique CSV list without coercing malformed query values', async () => {
  const query = await pipe.transform(
    { faqEntrySeqs: '3,1', limit: '100' },
    { type: 'query', metatype: AiFaqQueryDto },
  );
  assert.deepEqual(query.faqEntrySeqs, [3, 1]);
  for (const faqEntrySeqs of [
    '',
    '0',
    '2147483648',
    '1.5',
    '1,',
    '1,1',
    '1, 2',
    ['1', '2'],
    { id: 1 },
    Array.from({ length: 101 }, (_, i) => i + 1).join(','),
  ])
    await assert.rejects(() =>
      pipe.transform({ faqEntrySeqs }, { type: 'query', metatype: AiFaqQueryDto }),
    );
});

test('FAQ initial data contains all 32 question-answer pairs with provenance removed and rich answers preserved', () => {
  assert.equal(validateFaqSeed(seed).length, 32);
  for (const row of seed) {
    assert.deepEqual(Object.keys(row).sort(), ['answer', 'category', 'question']);
    assert.doesNotMatch(
      row.question + row.answer,
      /\[(?:일반|디포스트|디버|프로젝트|기업 추가 답변)\]|^#{1,3} /m,
    );
    assert.doesNotMatch(row.answer, /^\s*-\s*$/m);
  }
  assert.deepEqual(seed[1], {
    category: '접수',
    question: '한 번에 몇 개까지 접수할 수 있나요?',
    answer: '한 번에 최대 5건까지 접수할 수 있습니다.',
  });
  assert.equal(seed.at(-1).answer, '디포스트 고객센터 1811-4232');
  assert.match(
    seed.find((r) => r.question === '어떤 물품을 보낼 수 있나요?').answer,
    /- 현금, 어음, 수표/,
  );
  assert.match(
    seed.find((r) => r.question === '물품 종류는 어떻게 구분하나요?').answer,
    /\| 소박스 \| 세 변의 합 80cm 이하/,
  );
  assert.match(
    seed.find((r) => r.question === '주문 상태는 어떻게 나뉘나요?').answer,
    /취소완료 \(canceled\)/,
  );
});

test('FAQ creation uses the same items envelope for one or many entries and rejects legacy objects', async () => {
  const creation = new CreateFaqPipe();
  const item = { category: '기타', question: '질문', answer: '답변' };
  for (const length of [1, 2, 100])
    assert.equal((await creation.transform({ items: Array(length).fill(item) })).length, length);
  for (const input of [
    item,
    null,
    [],
    [item],
    {},
    { items: [] },
    { items: null },
    { items: item },
    { items: [null] },
    { items: [[item]] },
    { items: [item, { question: '질문' }] },
    { items: [{ ...item, updatedByAdminUserSeq: 1 }] },
    { items: [item], ...item },
    { items: Array(101).fill(item) },
  ])
    await assert.rejects(() => creation.transform(input));
});

test('FAQ deletion requires 1-100 unique positive integer IDs and rejects delete-all or coerced values', async () => {
  for (const ids of [[1], [1, 2], Array.from({ length: 100 }, (_, i) => i + 1)])
    assert.deepEqual(
      (await pipe.transform({ faqEntrySeqs: ids }, { type: 'body', metatype: DeleteFaqsDto }))
        .faqEntrySeqs,
      ids,
    );
  for (const input of [
    {},
    { faqEntrySeqs: [] },
    { faqEntrySeqs: null },
    { faqEntrySeqs: 1 },
    { faqEntrySeqs: [1, 1] },
    { faqEntrySeqs: ['1'] },
    { faqEntrySeqs: [0] },
    { faqEntrySeqs: [1.5] },
    { faqEntrySeqs: [2147483648] },
    { faqEntrySeqs: [1], all: true },
    { faqEntrySeqs: Array.from({ length: 101 }, (_, i) => i + 1) },
  ])
    await assert.rejects(() => pipe.transform(input, { type: 'body', metatype: DeleteFaqsDto }));
});

test('FAQ input allows multiline text but rejects nulls, empty text, server fields and invalid seed structures', async () => {
  const input = { category: '기타', question: '질문', answer: '첫 문단\n\n- 목록\n| 표 | 내용 |' };
  assert.equal(
    (await pipe.transform(input, { type: 'body', metatype: CreateFaqDto })).answer,
    input.answer,
  );
  for (const metatype of [CreateFaqDto, UpdateFaqDto]) {
    for (const patch of [
      { question: null },
      { answer: null },
      { question: '  \n\t' },
      { answer: '' },
      { question: 'x\0y' },
      { answer: 'x'.repeat(20001) },
      { isEnabled: true },
      { updatedByAdminUserSeq: 1 },
      { expectedVersion: 1 },
    ])
      await assert.rejects(() =>
        pipe.transform({ ...input, ...patch }, { type: 'body', metatype }),
      );
  }
  for (const invalid of [
    null,
    [],
    [{}],
    [{ category: '기타', question: '질문', answer: '답변', tag: '일반' }],
    [{ category: '기타', question: ' ', answer: '답변' }],
    [input, input],
  ])
    assert.throws(() => validateFaqSeed(invalid));
});
