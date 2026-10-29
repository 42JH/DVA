const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMemberCsv, CSV_MAX_BYTES, CSV_MAX_ROWS } = require('../dist/members/member-csv');
const header = 'employeeNo,name,phoneNumber,departmentSeq\n';
const file = (content) => ({
  buffer: Buffer.isBuffer(content) ? content : Buffer.from(content),
  originalname: 'employees.csv',
  mimetype: 'text/csv',
});
const rejects = (content, status, code) =>
  assert.throws(
    () => parseMemberCsv(file(content)),
    (error) => error.getStatus() === status && error.getResponse().code === code,
  );

test('CSV handles UTF-8 BOM, CRLF, quotes, commas and quoted newlines while preserving zeroes and case', () => {
  const rows = parseMemberCsv(
    file(
      '\ufeffemployeeNo,name,phoneNumber,departmentSeq\r\n 001a ," 김,민수 ",01012345678,7\r\n002A,"이\n지은",01023456789,8\r\n',
    ),
  );
  assert.deepEqual(rows, [
    { employeeNo: '001a', name: '김,민수', phoneNumber: '01012345678', departmentSeq: 7 },
    { employeeNo: '002A', name: '이\n지은', phoneNumber: '01023456789', departmentSeq: 8 },
  ]);
});
test('CSV rejects bad encoding, malformed quoting/columns, unsupported headers and empty input', () => {
  for (const content of [
    '',
    header,
    'name,phoneNumber\nA,0101',
    header + '001,"unclosed,0101',
    header + '001,A,0101,1,extra',
    header + '001,A',
    header + '\n001,A,0101',
    header + '001,A\u0000,0101',
    Buffer.from([0xff, 0xfe, 0x61]),
  ])
    rejects(content, 400, 'INVALID_REQUEST');
  assert.throws(
    () => parseMemberCsv(undefined),
    (error) => error.getStatus() === 400,
  );
  for (const upload of [
    { ...file(header + '001,A,0101'), originalname: 'employees.xlsx' },
    { ...file(header + '001,A,0101'), mimetype: 'application/pdf' },
  ])
    assert.throws(
      () => parseMemberCsv(upload),
      (error) => error.getStatus() === 415,
    );
});
test('CSV reports record numbers and duplicate/required/phone codes without echoing private fields', () => {
  assert.throws(
    () =>
      parseMemberCsv(
        file(header + '001,"Private\nName",01011111111,1\n001,Other,01011111111,1\n, ,010-2222,1'),
      ),
    (error) => {
      const body = error.getResponse();
      assert.equal(error.getStatus(), 422);
      assert.ok(
        body.details.some(
          (item) => item.field === 'rows[3].employeeNo' && item.reason === 'DUPLICATE_EMPLOYEE_NO',
        ),
      );
      assert.ok(
        body.details.some(
          (item) =>
            item.field === 'rows[3].phoneNumber' && item.reason === 'DUPLICATE_PHONE_NUMBER',
        ),
      );
      assert.ok(
        body.details.some(
          (item) => item.field === 'rows[4].employeeNo' && item.reason === 'REQUIRED',
        ),
      );
      assert.ok(
        body.details.some(
          (item) => item.field === 'rows[4].phoneNumber' && item.reason === 'INVALID_PHONE_NUMBER',
        ),
      );
      assert.ok(!JSON.stringify(body).match(/Private|01011111111|010-2222/));
      return true;
    },
  );
});
test('CSV enforces exact byte and data-row limits before unbounded parsing', () => {
  const row =
    '001,' +
    'a'.repeat(CSV_MAX_BYTES - Buffer.byteLength(header + '001,,01012345678,1')) +
    ',01012345678,1';
  assert.equal(file(header + row).buffer.length, CSV_MAX_BYTES);
  assert.equal(parseMemberCsv(file(header + row)).length, 1);
  rejects(header + row + 'a', 413, 'PAYLOAD_TOO_LARGE');
  const data = Array.from(
    { length: CSV_MAX_ROWS },
    (_, i) => `${i},Name,010${String(i).padStart(8, '0')},1`,
  ).join('\n');
  assert.equal(parseMemberCsv(file(header + data)).length, CSV_MAX_ROWS);
  rejects(header + data + '\n1001,Name,01099999999,1', 413, 'PAYLOAD_TOO_LARGE');
});

test('CSV requires a positive database department ID on every row', () => {
  for (const id of ['', 0, -1, '1.5', '1e2', 2147483648])
    rejects(header + `001,Name,01012345678,${id}`, 422, 'VALIDATION_FAILED');
});
