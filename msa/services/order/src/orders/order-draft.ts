import { isISO8601 } from 'class-validator';

export function isZonedDate(value: string): boolean {
  return (
    isISO8601(value, { strict: true, strictSeparator: true }) &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export const ORDER_ADDRESS_FIELDS = [
  'name',
  'phoneNumber',
  'roadAddress',
  'jibunAddress',
  'detailAddress',
  'dongName',
  'postalCode',
] as const;
