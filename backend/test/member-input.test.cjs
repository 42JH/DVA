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

test('inline employee role is optional, accepts only display roles and preserves omission', async () => {
  const input = { employeeNo: '001', name: '대표자', phoneNumber: '01012345678' };
  assert.equal((await pipe.transform(input))[0].role, undefined);
  for (const role of ['MEMBER', 'ORG_ADMIN'])
    assert.equal((await pipe.transform({ ...input, role }))[0].role, role);
  for (const role of [null, 'SYSTEM_ADMIN', 'OPERATOR', '', 1, true])
    await assert.rejects(
      () => pipe.transform({ items: [input, { ...input, employeeNo: '002', role }] }),
      (error) =>
        error.getStatus() === 400 &&
        error.getResponse().details.some((detail) => detail.field === 'items[1].role'),
    );
  await assert.rejects(() => pipe.transform({ customerSeq: 1, employeeNo: '001' }));
});

test('inline employees accept the customer address object in single and batch requests', async () => {
  const input = { employeeNo: '001', name: '주소 사원', phoneNumber: '01012345678' };
  const address = {
    roadAddress: '주소로 1',
    jibunAddress: '주소동 1',
    dongName: '주소동',
    postalCode: '01234',
    latitude: 37.5,
    longitude: 127,
  };
  for (const request of [{ ...input, address }, { items: [{ ...input, address }] }])
    assert.deepEqual(
      JSON.parse(JSON.stringify((await pipe.transform(request))[0].address)),
      address,
    );
  assert.equal((await pipe.transform(input))[0].address, undefined);
  assert.equal((await pipe.transform({ ...input, address: null }))[0].address, null);
  for (const coordinates of [
    {},
    { latitude: null, longitude: null },
    { latitude: 0, longitude: 0 },
    { latitude: 37.5 },
    { longitude: -127 },
  ]) {
    const partial = { ...address, ...coordinates };
    if (!('latitude' in coordinates)) delete partial.latitude;
    if (!('longitude' in coordinates)) delete partial.longitude;
    const actual = (await pipe.transform({ ...input, address: partial }))[0].address;
    assert.equal(actual.latitude, coordinates.latitude ?? 1);
    assert.equal(actual.longitude, coordinates.longitude ?? 1);
  }
  for (const field of ['roadAddress', 'jibunAddress', 'dongName', 'postalCode']) {
    const partial = { ...address };
    delete partial[field];
    await assert.rejects(
      () => pipe.transform({ items: [{ ...input, address: partial }] }),
      (error) =>
        error.getStatus() === 400 &&
        error.getResponse().details.some((detail) => detail.field === `items[0].address.${field}`),
    );
  }
  for (const invalid of [
    '주소로 1',
    [],
    { ...address, latitude: '37.5' },
    { ...address, longitude: 181 },
    { ...address, postalCode: '1234' },
    { ...address, detailAddress: null },
    { ...address, unknown: true },
  ])
    await assert.rejects(() => pipe.transform({ ...input, address: invalid }));
});
