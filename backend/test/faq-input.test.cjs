require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const seed = require('../data/delivery-faq.json');
const { validateFaqSeed } = require('../dist/faqs/faq-seed');
const { CreateFaqDto, UpdateFaqDto } = require('../dist/faqs/dto/faq-request.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const pipe = createValidationPipe();

test('FAQ initial data contains all 32 question-answer pairs with provenance removed and rich answers preserved', () => {
  assert.equal(validateFaqSeed(seed).length, 32);
  for (const row of seed) {
    assert.deepEqual(Object.keys(row).sort(), ['answer', 'question']);
    assert.doesNotMatch(
      row.question + row.answer,
      /\[(?:일반|디포스트|디버|프로젝트|기업 추가 답변)\]|^#{1,3} /m,
    );
    assert.doesNotMatch(row.answer, /^\s*-\s*$/m);
  }
  assert.deepEqual(seed[1], {
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

test('FAQ input allows multiline text but rejects nulls, empty text, server fields and invalid seed structures', async () => {
  const input = { question: '질문', answer: '첫 문단\n\n- 목록\n| 표 | 내용 |' };
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
    [{ question: '질문', answer: '답변', tag: '일반' }],
    [{ question: ' ', answer: '답변' }],
    [input, input],
  ])
    assert.throws(() => validateFaqSeed(invalid));
});
