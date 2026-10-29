import { parse } from 'csv-parse/sync';
import { ApiException, ErrorDetail } from '../common/errors/api.exception';
import { CsvMemberRow, CsvUpload } from './members.types';

export const CSV_MAX_BYTES = 1024 * 1024;
export const CSV_MAX_ROWS = 1000;
const headers = ['employeeNo', 'name', 'phoneNumber', 'departmentSeq'];

export function parseMemberCsv(file: CsvUpload | undefined): CsvMemberRow[] {
  if (!file) throw new ApiException(400, 'INVALID_REQUEST', 'CSV 파일 1개가 필요합니다.');
  if (file.buffer.length > CSV_MAX_BYTES)
    throw new ApiException(413, 'PAYLOAD_TOO_LARGE', 'CSV 파일은 최대 1MiB입니다.');
  if (
    !/\.csv$/i.test(file.originalname) ||
    ![
      'text/csv',
      'application/csv',
      'application/vnd.ms-excel',
      'application/octet-stream',
      'text/plain',
    ].includes(file.mimetype)
  )
    throw new ApiException(415, 'UNSUPPORTED_MEDIA_TYPE', 'UTF-8 CSV 파일만 지원합니다.');
  let records: string[][];
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    if (text.includes('\u0000')) throw new Error('Invalid CSV text');
    // Stop after one excess record so a small file with many tiny rows stays bounded.
    records = parse(text, {
      bom: true,
      to: CSV_MAX_ROWS + 2,
      max_record_size: CSV_MAX_BYTES,
    }) as string[][];
  } catch {
    throw new ApiException(400, 'INVALID_REQUEST', 'CSV 인코딩·따옴표·열 개수를 확인해 주세요.');
  }
  if (records.length > CSV_MAX_ROWS + 1)
    throw new ApiException(413, 'PAYLOAD_TOO_LARGE', 'CSV 데이터는 최대 1,000행입니다.');
  if (
    records.length < 2 ||
    records[0].length !== headers.length ||
    records[0].some((value, i) => value !== headers[i])
  )
    throw new ApiException(400, 'INVALID_REQUEST', 'CSV 헤더와 데이터 행을 확인해 주세요.');
  const errors: ErrorDetail[] = [];
  const employees = new Set<string>();
  const phones = new Set<string>();
  const rows = records.slice(1).map(([employee, rawName, phoneNumber, department], index) => {
    const employeeNo = employee.trim();
    const name = rawName.trim();
    const departmentSeq = Number(department);
    const add = (field: string, reason: string) =>
      errors.push({ field: `rows[${index + 2}].${field}`, reason });
    if (!employeeNo) add('employeeNo', 'REQUIRED');
    if (!name) add('name', 'REQUIRED');
    if (
      !/^[0-9]+$/.test(department) ||
      !Number.isInteger(departmentSeq) ||
      departmentSeq < 1 ||
      departmentSeq > 2147483647
    )
      add('departmentSeq', 'INVALID_DEPARTMENT_ID');
    if (!phoneNumber) add('phoneNumber', 'REQUIRED');
    else if (!/^[0-9]+$/.test(phoneNumber)) add('phoneNumber', 'INVALID_PHONE_NUMBER');
    if (employees.has(employeeNo)) add('employeeNo', 'DUPLICATE_EMPLOYEE_NO');
    if (phones.has(phoneNumber)) add('phoneNumber', 'DUPLICATE_PHONE_NUMBER');
    employees.add(employeeNo);
    phones.add(phoneNumber);
    return { employeeNo, name, phoneNumber, departmentSeq };
  });
  if (errors.length)
    throw new ApiException(422, 'VALIDATION_FAILED', 'CSV 행을 확인해 주세요.', errors);
  return rows;
}
