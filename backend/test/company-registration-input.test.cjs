require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CreateOrganizationPipe } = require('../dist/organizations/create-organization.pipe');
const pipe = new CreateOrganizationPipe();
const employee = (extra = {}) => ({
  employeeNo: '001',
  name: '사원',
  phoneNumber: '01012345678',
  ...extra,
});

test('company registration preserves old input and validates optional departments and employee display roles', async () => {
  const old = await pipe.transform({ name: ' 기업 ', monthlyBillingEnabled: true });
  assert.equal(old.name, '기업');
  assert.equal(old.departments, undefined);
  assert.equal(old.members, undefined);
  const input = await pipe.transform({
    name: '기업',
    departments: [{ name: ' 개발팀 ', groupBillingEnabled: true }],
    members: [employee({ departmentName: ' 개발팀 ', role: 'ORG_ADMIN' })],
  });
  assert.equal(input.departments[0].name, '개발팀');
  assert.equal(input.members[0].departmentName, '개발팀');
  assert.equal(input.members[0].role, 'ORG_ADMIN');
  assert.equal(
    (await pipe.transform({ name: '기업', members: [employee()] })).members[0].role,
    undefined,
  );
  await pipe.transform({ name: '기업', departments: [], members: [] });
  await pipe.transform({ name: '기업', members: [employee({ departmentName: null })] });
});

test('company registration rejects invalid nested input with bracketed fields without exposing personal data', async () => {
  for (const input of [
    null,
    [],
    1,
    {},
    { name: ' ' },
    { name: '기업', unknown: 1 },
    { name: '기업', departments: null },
    { name: '기업', departments: {} },
    { name: '기업', departments: [null] },
    { name: '기업', departments: [[]] },
    { name: '기업', departments: [{ name: 'A', groupBillingEnabled: 'true' }] },
    { name: '기업', departments: [{ name: 'A', departmentSeq: 1 }] },
    { name: '기업', members: null },
    { name: '기업', members: {} },
    { name: '기업', members: [null] },
    { name: '기업', members: [[]] },
    ...[null, 'SYSTEM_ADMIN', 1].map((role) => ({ name: '기업', members: [employee({ role })] })),
    { name: '기업', members: [employee({ phoneNumber: 101 })] },
    { name: '기업', members: [employee({ departmentSeq: 1 })] },
    { name: '기업', members: [employee({ customerSeq: 1 })] },
    { name: '기업', members: [employee({ departmentName: '' })] },
    { name: '기업', members: [employee({ departmentName: 'A'.repeat(101) })] },
  ])
    await assert.rejects(
      () => pipe.transform(input),
      (error) => error.getStatus() === 400,
    );
  await assert.rejects(
    () =>
      pipe.transform({ name: '기업', members: [employee(), employee({ role: 'SYSTEM_ADMIN' })] }),
    (error) => {
      const response = error.getResponse();
      assert.ok(response.details.some((detail) => detail.field === 'members[1].role'));
      assert.ok(!JSON.stringify(response).includes('01012345678'));
      return error.getStatus() === 400;
    },
  );
});

test('company registration rejects duplicate identifiers and undeclared departments before persistence', async () => {
  for (const [input, field, status, reason] of [
    [
      { name: '기업', departments: [{ name: 'A' }, { name: ' A ' }] },
      'departments[1].name',
      400,
      'DUPLICATE_ITEM',
    ],
    [
      { name: '기업', members: [employee(), employee({ phoneNumber: '01087654321' })] },
      'members[1].employeeNo',
      400,
      'DUPLICATE_ITEM',
    ],
    [
      { name: '기업', members: [employee(), employee({ employeeNo: '002' })] },
      'members[1].phoneNumber',
      400,
      'DUPLICATE_ITEM',
    ],
    [
      { name: '기업', members: [employee({ departmentName: '없는 부서' })] },
      'members[0].departmentName',
      422,
      'DEPARTMENT_NOT_FOUND',
    ],
  ])
    await assert.rejects(
      () => pipe.transform(input),
      (error) =>
        error.getStatus() === status &&
        error
          .getResponse()
          .details.some((detail) => detail.field === field && detail.reason === reason),
    );
});

test('company registration accepts 1000 employees and rejects arrays above the per-request limit', async () => {
  const members = Array.from({ length: 1000 }, (_, index) =>
    employee({ employeeNo: String(index), phoneNumber: '010' + String(index).padStart(8, '0') }),
  );
  assert.equal((await pipe.transform({ name: '기업', members })).members.length, 1000);
  await assert.rejects(() => pipe.transform({ name: '기업', members: [...members, employee()] }));
  await assert.rejects(() =>
    pipe.transform({
      name: '기업',
      departments: Array.from({ length: 1001 }, (_, index) => ({ name: String(index) })),
    }),
  );
});

test('company members inherit address validation without coordinates and keep indexed error paths', async () => {
  const address = {
    roadAddress: '주소로 1',
    jibunAddress: '주소동 1',
    detailAddress: '',
    dongName: '주소동',
    postalCode: '01234',
  };
  const input = await pipe.transform({ name: '주소 기업', members: [employee({ address })] });
  assert.deepEqual({ ...input.members[0].address }, address);
  assert.equal(
    (await pipe.transform({ name: '기업', members: [employee({ address: null })] })).members[0]
      .address,
    null,
  );
  await assert.rejects(
    () =>
      pipe.transform({
        name: '주소 기업',
        members: [employee({ address: { ...address, latitude: 37.5 } })],
      }),
    (error) =>
      error.getStatus() === 400 &&
      error
        .getResponse()
        .details.some((detail) => detail.field === 'members[0].address.latitude') &&
      !JSON.stringify(error.getResponse()).includes('주소로 1'),
  );
});
