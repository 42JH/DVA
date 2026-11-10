require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CreateOrderDto } = require('../dist/orders/dto/create-order.dto');
const { OrderQueryDto, OrderIdParamsDto } = require('../dist/orders/dto/order-query.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const { UpdateOrderDto } = require('../dist/orders/dto/update-order.dto');
const { CancelOrderParcelsDto } = require('../dist/orders/dto/cancel-order-parcels.dto');
const { assertOrderUpdate } = require('../dist/orders/order-update.validation');
const customerAddress = require('./helpers/customer-address.cjs');

const pipe = createValidationPipe();
const validate = (body) => pipe.transform(body, { type: 'body', metatype: CreateOrderDto });

test('customer registration requires a complete address while detail address remains optional', async () => {
  const {
    CreateCustomerDto,
    UpdateCustomerDto,
  } = require('../dist/customers/dto/customer-request.dto');
  const address = {
    roadAddress: '등록로 1',
    jibunAddress: '등록동 1',
    dongName: '등록동',
    postalCode: '00001',
  };
  const transform = (value) =>
    pipe.transform(
      { name: '고객', phoneNumber: '01012345678', address: value },
      { type: 'body', metatype: CreateCustomerDto },
    );
  for (const detail of [undefined, '']) {
    const input = await transform({ ...address, detailAddress: detail });
    assert.equal(input.address.postalCode, '00001');
    assert.equal(input.address.detailAddress, detail);
  }
  for (const value of [undefined, null, {}, [], '주소']) {
    await assert.rejects(
      () => transform(value),
      (error) =>
        error.getStatus() === 400 &&
        error.getResponse().details.some((detail) => detail.field.startsWith('address')),
    );
  }
  for (const field of ['roadAddress', 'jibunAddress', 'dongName', 'postalCode']) {
    for (const missing of [undefined, null, '']) {
      await assert.rejects(
        () => transform({ ...address, [field]: missing }),
        (error) =>
          error.getStatus() === 400 &&
          error.getResponse().details.some((detail) => detail.field === 'address.' + field),
      );
    }
  }
  await pipe.transform({ name: '수정 이름' }, { type: 'body', metatype: UpdateCustomerDto });
  await pipe.transform({ address: null }, { type: 'body', metatype: UpdateCustomerDto });
});

test('order item values are limited to one won through one hundred million across create, manual and update', async () => {
  const { CreateManualOrderDto } = require('../dist/orders/dto/manual-order.dto');
  for (const [metatype, base] of [
    [CreateOrderDto, { customerSeq: 1 }],
    [CreateManualOrderDto, { customerSeq: 1 }],
    [UpdateOrderDto, { expectedVersion: 1 }],
  ]) {
    const transform = (parcel) =>
      pipe.transform({ ...base, parcels: [parcel] }, { type: 'body', metatype });
    for (const itemPrice of [1, 99999999, 100000000]) {
      const input = await transform({ itemPrice });
      assert.equal(input.parcels[0].itemPrice, itemPrice);
    }
    for (const itemPrice of [
      0,
      -1,
      100000001,
      9000000000,
      Number.MAX_SAFE_INTEGER,
      1.5,
      '1000',
      true,
    ]) {
      await assert.rejects(
        () => transform({ itemPrice }),
        (error) =>
          error.getStatus() === 400 &&
          error.getResponse().details.some((detail) => detail.field === 'parcels.0.itemPrice'),
        metatype.name + ': ' + JSON.stringify(itemPrice),
      );
    }
    assert.equal((await transform({})).parcels[0].itemPrice, undefined);
    assert.equal((await transform({ itemPrice: null })).parcels[0].itemPrice, null);
  }
});

test('business phone inputs require exactly eleven ASCII digits without normalization', async () => {
  const {
    CreateCustomerDto,
    ListCustomersQueryDto,
  } = require('../dist/customers/dto/customer-request.dto');
  const { CallerContextRequestDto } = require('../dist/customers/dto/caller-context.dto');
  const { InlineMemberDto } = require('../dist/members/dto/member-request.dto');
  const { CreatePinDto, UpdatePinDto } = require('../dist/pins/dto/pin-request.dto');
  const { CreateManualOrderDto } = require('../dist/orders/dto/manual-order.dto');
  const address = (phoneNumber) => ({
    name: '수령인',
    phoneNumber,
    roadAddress: '검증로 1',
    jibunAddress: '검증동 1',
    dongName: '검증동',
    postalCode: '00001',
  });
  for (const [metatype, body] of [
    [
      CreateCustomerDto,
      (phoneNumber) => ({ name: '고객', phoneNumber, address: customerAddress() }),
    ],
    [CallerContextRequestDto, (phoneNumber) => ({ phoneNumber })],
    [InlineMemberDto, (phoneNumber) => ({ employeeNo: '001', name: '직원', phoneNumber })],
    [CreatePinDto, (phoneNumber) => ({ addressData: address(phoneNumber) })],
    [UpdatePinDto, (phoneNumber) => ({ addressData: address(phoneNumber) })],
    [CreateOrderDto, (phoneNumber) => ({ customer: { name: '고객', phoneNumber } })],
    [CreateOrderDto, (phoneNumber) => ({ customerSeq: 1, parcels: [{ origin: { phoneNumber } }] })],
    [
      UpdateOrderDto,
      (phoneNumber) => ({ expectedVersion: 1, parcels: [{ destination: { phoneNumber } }] }),
    ],
    [
      CreateManualOrderDto,
      (phoneNumber) => ({ customerSeq: 1, parcels: [{ destination: address(phoneNumber) }] }),
    ],
  ]) {
    const transform = (phoneNumber) =>
      pipe.transform(body(phoneNumber), { type: 'body', metatype });
    for (const phoneNumber of ['01012345678', '01000000000']) await transform(phoneNumber);
    for (const phoneNumber of [
      '021234567',
      '0101234567',
      '010123456789',
      '010-1234-5678',
      '+821012345678',
      ' 01012345678',
      '01012345678 ',
      '01012345678\n',
      '０１０１２３４５６７８',
      '',
      1012345678,
      false,
    ])
      await assert.rejects(
        () => transform(phoneNumber),
        (error) =>
          error.getStatus() === 400 &&
          error.getResponse().details.some((detail) => detail.field.endsWith('phoneNumber')),
        metatype.name + ': ' + JSON.stringify(phoneNumber),
      );
  }
});

test('collecting an order still permits omitted or cleared phones and partial searches', async () => {
  for (const phoneNumber of [undefined, null]) {
    const created = await validate({ customerSeq: 1, parcels: [{ origin: { phoneNumber } }] });
    assert.equal(created.parcels[0].origin.phoneNumber, phoneNumber);
    const updated = await pipe.transform(
      { expectedVersion: 1, parcels: [{ destination: { phoneNumber } }] },
      { type: 'body', metatype: UpdateOrderDto },
    );
    assert.equal(updated.parcels[0].destination.phoneNumber, phoneNumber);
  }
  const { ListCustomersQueryDto } = require('../dist/customers/dto/customer-request.dto');
  for (const phoneNumber of ['0', '010', '1234', '021234567', '01012345678'])
    assert.equal(
      (await pipe.transform({ phoneNumber }, { type: 'query', metatype: ListCustomersQueryDto }))
        .phoneNumber,
      phoneNumber,
    );
  for (const phoneNumber of [
    '',
    '123456789012',
    '010-1234',
    '123\n',
    ' 123',
    '１２３',
    '%',
    ['123', '456'],
    123,
  ])
    await assert.rejects(
      () => pipe.transform({ phoneNumber }, { type: 'query', metatype: ListCustomersQueryDto }),
      (error) => error.getStatus() === 400,
    );
  assert.equal(
    (await pipe.transform({ q: '010' }, { type: 'query', metatype: ListCustomersQueryDto })).q,
    '010',
  );
});

test('parcel cancellation requires a nonempty unique array of database integers', async () => {
  const validateCancellation = (body) =>
    pipe.transform(body, { type: 'body', metatype: CancelOrderParcelsDto });
  for (const orderParcelSeqs of [[1], [3, 1, 2147483647]])
    assert.deepEqual(
      (await validateCancellation({ orderParcelSeqs })).orderParcelSeqs,
      orderParcelSeqs,
    );
  for (const body of [
    {},
    null,
    [],
    { orderParcelSeq: 1 },
    { orderParcelSeqs: [1], status: 'CANCELLED' },
    ...[
      null,
      [],
      1,
      '1',
      {},
      [1, 1],
      [0],
      [-1],
      [1.5],
      ['1'],
      [true],
      [null],
      [[1]],
      [2147483648],
    ].map((orderParcelSeqs) => ({ orderParcelSeqs })),
  ])
    await assert.rejects(
      () => validateCancellation(body),
      (error) => error.getStatus() === 400,
    );
});

const validateUpdate = async (body) => {
  const input = await pipe.transform(body, { type: 'body', metatype: UpdateOrderDto });
  assertOrderUpdate(input);
  return input;
};

test('customer, PIN and order requests reject retired coordinates, including null and zero', async () => {
  const {
    CreateCustomerDto,
    UpdateCustomerDto,
  } = require('../dist/customers/dto/customer-request.dto');
  const { CreatePinDto, UpdatePinDto } = require('../dist/pins/dto/pin-request.dto');
  const { CreateManualOrderDto } = require('../dist/orders/dto/manual-order.dto');
  const address = {
    roadAddress: '검증로 1',
    jibunAddress: '검증동 1',
    dongName: '검증동',
    postalCode: '00001',
  };
  const recipient = { ...address, name: '수령인', phoneNumber: '01012345678' };
  for (const [metatype, body, getAddress] of [
    [
      CreateCustomerDto,
      { name: '고객', phoneNumber: '01012345678', address },
      (input) => input.address,
    ],
    [UpdateCustomerDto, { address }, (input) => input.address],
    [CreatePinDto, { addressData: recipient }, (input) => input.addressData],
    [UpdatePinDto, { addressData: recipient }, (input) => input.addressData],
    [
      CreateOrderDto,
      { customerSeq: 1, parcels: [{ origin: recipient }] },
      (input) => input.parcels[0].origin,
    ],
    [
      UpdateOrderDto,
      { expectedVersion: 1, parcels: [{ destination: recipient }] },
      (input) => input.parcels[0].destination,
    ],
    [
      CreateManualOrderDto,
      { customerSeq: 1, parcels: [{ origin: recipient }] },
      (input) => input.parcels[0].origin,
    ],
  ]) {
    const transform = (input) => pipe.transform(input, { type: 'body', metatype });
    const validated = await transform(structuredClone(body));
    assert.deepEqual(JSON.parse(JSON.stringify(getAddress(validated))), getAddress(body));
    assert.equal(Object.hasOwn(getAddress(validated), 'latitude'), false);
    assert.equal(Object.hasOwn(getAddress(validated), 'longitude'), false);
    for (const field of ['latitude', 'longitude'])
      for (const value of [0, 37.5, null, '127']) {
        const invalid = structuredClone(body);
        getAddress(invalid)[field] = value;
        await assert.rejects(
          () => transform(invalid),
          (error) =>
            error.getStatus() === 400 &&
            error
              .getResponse()
              .details.some(
                (detail) =>
                  detail.field.endsWith('.' + field) && detail.reason === 'whitelistValidation',
              ),
          metatype.name + '.' + field + '=' + value,
        );
      }
  }
});

test('clients cannot inject parcel cancellation state through creation or editing', async () => {
  await assert.rejects(
    () => validate({ customerSeq: 1, parcels: [{ status: 'CANCELLED' }] }),
    (error) => error.getStatus() === 400,
  );
  await assert.rejects(
    () =>
      validateUpdate({ expectedVersion: 1, parcels: [{ orderParcelSeq: 1, status: 'CANCELLED' }] }),
    (error) => error.getStatus() === 400,
  );
});

test('order updates preserve omitted fields, nullable clears, zero and empty text', async () => {
  const input = await validateUpdate({
    expectedVersion: 4,
    pickupRequestedAt: null,
    parcels: [
      { orderParcelSeq: 101, origin: { name: null }, clientComment: '' },
      { originPin: null, documentCount: 0, itemPrice: null },
    ],
  });
  assert.equal(input.paymentMethodType, undefined);
  assert.equal(input.pickupRequestedAt, null);
  assert.equal(input.parcels[0].smallBoxCount, undefined);
  assert.equal(input.parcels[0].origin.name, null);
  assert.equal(input.parcels[0].origin.phoneNumber, undefined);
  assert.equal(input.parcels[0].clientComment, '');
  assert.equal(input.parcels[1].orderParcelSeq, undefined);
  assert.equal(input.parcels[1].documentCount, 0);
  assert.equal(input.parcels[1].itemPrice, null);
  await validateUpdate({ expectedVersion: 1, paymentMethodType: 'billing', parcels: [] });
});

test('order updates reject missing changes, duplicate details, invalid fields and value types', async () => {
  for (const input of [
    {},
    { paymentMethodType: 'billing' },
    { expectedVersion: '1', paymentMethodType: 'billing' },
    { expectedVersion: null, paymentMethodType: 'billing' },
    { expectedVersion: 0, paymentMethodType: 'billing' },
    { expectedVersion: 2147483648, paymentMethodType: 'billing' },
    { expectedVersion: 1 },
    { expectedVersion: 1, parcels: [] },
    { expectedVersion: 1, parcels: [{}] },
    { expectedVersion: 1, parcels: [{ origin: {} }] },
    { expectedVersion: 1, parcels: [{ orderParcelSeq: 1, destination: {} }] },
    { expectedVersion: 1, parcels: [{ orderParcelSeq: 1 }] },
    { expectedVersion: 1, paymentMethodType: 'billing', parcels: [{}] },
    { expectedVersion: 1, paymentMethodType: null },
    { expectedVersion: 1, paymentMethodType: 'cash' },
    { expectedVersion: 1, paymentMethodType: 'cat' },
    { expectedVersion: 1, pickupRequestedAt: '2026-02-30T10:00:00Z' },
    { expectedVersion: 1, pickupRequestedAt: '2026-10-28T10:00:00' },
    { expectedVersion: 1, pickupRequestedAt: '2026-10-28T10:00:00+25:00' },
    { expectedVersion: 1, customerSeq: 1 },
    { expectedVersion: 1, status: 'ACCEPTED' },
    { expectedVersion: 1, parcels: null },
    { expectedVersion: 1, parcels: [null] },
    { expectedVersion: 1, parcels: [[{}]] },
    ...[null, 0, '1', 1.5, 2147483648].map((orderParcelSeq) => ({
      expectedVersion: 1,
      parcels: [{ orderParcelSeq, smallBoxCount: 1 }],
    })),
    ...[
      { origin: null },
      { destination: [] },
      { origin: { extra: 1 } },
      { origin: { phoneNumber: '010-1234' } },
      { origin: { latitude: 91 } },
      { originPin: {} },
      { originPin: { scope: 'PERSONAL', pinSeq: null } },
      { itemPrice: Number.MAX_SAFE_INTEGER + 1 },
      { clientComment: null },
      { smallBoxCount: null },
      { smallBoxCount: -1 },
      { notifiedPrice: 0 },
      { parcelPosition: 1 },
    ].map((parcel) => ({ expectedVersion: 1, parcels: [parcel] })),
    {
      expectedVersion: 1,
      parcels: [
        { orderParcelSeq: 1, smallBoxCount: 1 },
        { orderParcelSeq: 1, smallBoxCount: 2 },
      ],
    },
  ])
    await assert.rejects(
      () => validateUpdate(input),
      (error) => {
        assert.equal(error.getStatus(), 400);
        assert.equal(error.getResponse().code, 'INVALID_REQUEST');
        return true;
      },
      JSON.stringify(input),
    );
});

test('order queries validate dates, enum filters, integer pagination and unknown fields', async () => {
  const query = (value) => pipe.transform(value, { type: 'query', metatype: OrderQueryDto });
  const defaults = await query({});
  assert.equal(defaults.limit, 20);
  assert.equal(defaults.offset, 0);
  assert.equal(defaults.customerSeq, undefined);
  const result = await query({
    customerSeq: '31',
    limit: '100',
    offset: '2',
    from: '2026-10-27T00:00:00+09:00',
    to: '2026-10-28T00:00:00Z',
    status: 'COLLECTING',
    recipientName: ' 수령인 ',
  });
  assert.equal(result.customerSeq, 31);
  assert.equal(result.limit, 100);
  assert.equal(result.offset, 2);
  assert.equal(result.recipientName, '수령인');
  assert.equal(result.status, 'COLLECTING');
  for (const input of [
    { customerSeq: '0' },
    { customerSeq: '2147483648' },
    { customerSeq: '1e2' },
    { customerSeq: ['1', '2'] },
    { limit: '0' },
    { limit: '101' },
    { limit: '' },
    { offset: '-1' },
    { offset: '1.5' },
    { status: 'paid' },
    { shipmentStatus: 'paid' },
    { recipientName: '   ' },
    { recipientName: ['a', 'b'] },
    { from: '2026-02-30T00:00:00Z' },
    { to: '2026-10-28T00:00:00' },
    { unexpected: '1' },
  ])
    await assert.rejects(
      () => query(input),
      (error) => error.getStatus() === 400,
      JSON.stringify(input),
    );
});

test('order path IDs accept only positive PostgreSQL integers', async () => {
  const params = (id) => pipe.transform({ id }, { type: 'param', metatype: OrderIdParamsDto });
  assert.equal((await params('2147483647')).id, 2147483647);
  for (const id of ['0', '-1', '2147483648', '1.5', '1e2', '+1', 'abc', '1 OR 1=1'])
    await assert.rejects(
      () => params(id),
      (error) => error.getStatus() === 400,
      id,
    );
});

test('collecting orders accept missing details and preserve nullable fields and leading zeros', async () => {
  const minimal = await validate({ customerSeq: 31 });
  assert.equal(minimal.parcels, undefined);
  assert.equal(minimal.paymentMethodType, undefined);
  assert.deepEqual((await validate({ customerSeq: 31, parcels: [] })).parcels, []);
  const partial = await validate({
    customerSeq: 31,
    pickupRequestedAt: null,
    parcels: [
      {
        origin: { name: '발송인', phoneNumber: '01012345678', roadAddress: null },
        originPin: null,
        itemPrice: null,
      },
    ],
  });
  assert.equal(partial.parcels[0].origin.phoneNumber, '01012345678');
  assert.equal(partial.parcels[0].origin.roadAddress, null);
  assert.equal(partial.parcels[0].itemPrice, null);
});

test('order inputs preserve zero, explicit timezone and PostgreSQL numeric boundaries', async () => {
  const result = await validate({
    customerSeq: 2147483647,
    paymentMethodType: 'billing',
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
    parcels: [
      {
        origin: { postalCode: '00001' },
        documentCount: 0,
        smallBoxCount: 2147483647,
        itemPrice: 100000000,
      },
    ],
  });
  assert.equal(result.parcels[0].origin.postalCode, '00001');
  assert.equal(result.parcels[0].documentCount, 0);
  assert.equal(result.parcels[0].itemPrice, 100000000);
});

test('orders accept customer identity without an existing customer ID', async () => {
  const input = { customer: { name: '신규 고객', phoneNumber: '01000550001' } };
  const result = await validate(input);
  assert.equal(result.customerSeq, undefined);
  assert.equal(result.customer.name, input.customer.name);
  assert.equal(result.customer.phoneNumber, input.customer.phoneNumber);
});

test('order inputs reject invalid types, nulls, ranges, nested arrays and extra fields', async () => {
  const bodies = [
    {},
    { customerSeq: '31' },
    { customerSeq: 0 },
    { customerSeq: 2147483648 },
    { customer: null },
    { customer: [] },
    { customer: {} },
    { customer: { name: ' \t', phoneNumber: '01000550001' } },
    { customer: { name: 1, phoneNumber: '01000550001' } },
    { customer: { name: '고객', phoneNumber: 1000550001 } },
    { customer: { name: '고객', phoneNumber: '010-0055-0001' } },
    { customer: { name: '고객', phoneNumber: '' } },
    { customer: { name: '고객', phoneNumber: '01000550001', status: 'ACTIVE' } },
    { customerSeq: 31, paymentMethodType: null },
    { customerSeq: 31, paymentMethodType: 'cash' },
    { customerSeq: 31, paymentMethodType: 'cat' },
    { customerSeq: 31, pickupRequestedAt: '2026-10-28T10:00:00' },
    { customerSeq: 31, pickupRequestedAt: '2026-02-30T10:00:00Z' },
    { customerSeq: 31, parcels: null },
    { customerSeq: 31, parcels: [null] },
    { customerSeq: 31, parcels: [[{}]] },
    { customerSeq: 31, parcels: [{ origin: null }] },
    { customerSeq: 31, parcels: [{ origin: [] }] },
    { customerSeq: 31, parcels: [{ origin: { phoneNumber: '010-1234-5678' } }] },
    { customerSeq: 31, parcels: [{ origin: { latitude: 91 } }] },
    { customerSeq: 31, parcels: [{ origin: { longitude: -181 } }] },
    { customerSeq: 31, parcels: [{ origin: { latitude: Infinity } }] },
    { customerSeq: 31, parcels: [{ originPin: { scope: 'PERSONAL' } }] },
    { customerSeq: 31, parcels: [{ documentCount: null }] },
    { customerSeq: 31, parcels: [{ documentCount: -1 }] },
    { customerSeq: 31, parcels: [{ documentCount: 1.5 }] },
    { customerSeq: 31, parcels: [{ documentCount: '1' }] },
    { customerSeq: 31, parcels: [{ itemPrice: Number.MAX_SAFE_INTEGER + 1 }] },
    { customerSeq: 31, parcels: [{ notifiedPrice: 0 }] },
    { customerSeq: 31, parcels: [{ origin: { unexpected: true } }] },
    { customerSeq: 31, status: 'ACCEPTED' },
  ];
  for (const body of bodies) {
    await assert.rejects(
      () => validate(body),
      (error) => {
        assert.equal(error.getStatus(), 400);
        assert.equal(error.getResponse().code, 'INVALID_REQUEST');
        return true;
      },
      JSON.stringify(body),
    );
  }
});

test('admin order screen validates only bounded screen filters and preserves strict pagination', async () => {
  const { AdminOrderListQueryDto } = require('../dist/orders/dto/admin-order-list.dto');
  const input = {
    q: '  한글 ',
    statusGroup: 'PAID',
    from: '2026-10-31T00:00:00+09:00',
    to: '2026-11-01T00:00:00+09:00',
    limit: '1',
    offset: '2',
  };
  const result = await pipe.transform(input, { type: 'query', metatype: AdminOrderListQueryDto });
  assert.equal(result.q, '한글');
  assert.equal(result.limit, 1);
  assert.equal(result.offset, 2);
  for (const statusGroup of [
    'COLLECTING',
    'notPaid',
    'PAID',
    'ACCEPTED',
    'SUBMISSION_FAILED',
    'CANCELLED',
  ])
    assert.equal(
      (await pipe.transform({ statusGroup }, { type: 'query', metatype: AdminOrderListQueryDto }))
        .statusGroup,
      statusGroup,
    );
  for (const patch of [
    { q: ['a'] },
    { q: 'x\0' },
    { q: 'x'.repeat(201) },
    { statusGroup: ['PAID'] },
    { statusGroup: 'SUBMITTING' },
    { statusGroup: 'SUBMITTING_FAILED' },
    { statusGroup: 'SUMBITTING' },
    { status: 'PAID' },
    { limit: '1.0' },
    { offset: '-1' },
    { from: '2026-10-31' },
  ])
    await assert.rejects(
      () =>
        pipe.transform({ ...input, ...patch }, { type: 'query', metatype: AdminOrderListQueryDto }),
      { status: 400 },
    );
});

test('admin parcel removal validates IDs and rejects ambiguous update/remove operations', async () => {
  assert.deepEqual(
    (await validateUpdate({ expectedVersion: 1, removeParcelSeqs: [101, 102] })).removeParcelSeqs,
    [101, 102],
  );
  for (const removeParcelSeqs of [
    null,
    [],
    '101',
    [101, 101],
    [0],
    [-1],
    [1.5],
    ['101'],
    [2147483648],
  ])
    await assert.rejects(() => validateUpdate({ expectedVersion: 1, removeParcelSeqs }), {
      status: 400,
    });
  await assert.rejects(
    () =>
      validateUpdate({
        expectedVersion: 1,
        removeParcelSeqs: [101],
        parcels: [{ orderParcelSeq: 101, notifiedPrice: 3000 }],
      }),
    { status: 400 },
  );
});
