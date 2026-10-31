require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CreateMemberPipe } = require('../dist/members/create-member.pipe');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const { UpdateMemberDto } = require('../dist/members/dto/member-request.dto');
const pipe = new CreateMemberPipe();

test('single and mixed batch employees validate without coercion, unknown keys or duplicate identifiers', async () => {
  const reference = { customerSeq: 1, employeeNo: '001', role: 'MEMBER' };
  const inline = {
    employeeNo: '002',
    name: ' 김,직원 ',
    phoneNumber: '01012345678',
    departmentSeq: null,
  };
  assert.equal((await pipe.transform(reference))[0].customerSeq, 1);
  const result = await pipe.transform({ items: [reference, inline] });
  assert.equal(result.length, 2);
  assert.equal(result[1].name, '김,직원');
  for (const input of [
    undefined,
    null,
    [],
    42,
    {},
    { items: [] },
    { items: [null] },
    { items: [reference, reference] },
    { items: [inline, { ...inline, employeeNo: '003' }] },
    { ...reference, name: '같이 보낼 수 없음' },
    { ...reference, departmentSeq: 0 },
    { ...reference, departmentSeq: '1' },
    { ...inline, phoneNumber: '0101\n' },
    { ...inline, phoneNumber: 101 },
    { ...inline, name: ' ' },
    { ...inline, unknown: 1 },
    { items: [reference], unknown: 1 },
    { items: Array.from({ length: 1001 }, () => reference) },
  ]) {
    await assert.rejects(
      () => pipe.transform(input),
      (e) => e.getStatus() === 400,
    );
  }
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    customerSeq: i + 1,
    employeeNo: String(i),
    role: 'MEMBER',
  }));
  assert.equal((await pipe.transform({ items: rows })).length, 1000);
});

test('department PATCH distinguishes omission and null and still rejects foreign scalar types', async () => {
  const validation = createValidationPipe();
  const transform = (value) =>
    validation.transform(value, { type: 'body', metatype: UpdateMemberDto });
  assert.equal((await transform({ role: 'MEMBER' })).departmentSeq, undefined);
  assert.equal((await transform({ departmentSeq: null })).departmentSeq, null);
  assert.equal((await transform({ departmentSeq: 1 })).departmentSeq, 1);
  for (const value of [0, -1, 2147483648, '1', true, {}, []])
    await assert.rejects(() => transform({ departmentSeq: value }));
});
