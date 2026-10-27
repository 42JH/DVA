import { ApiException, ErrorDetail } from '../common/errors/api.exception';
import {
  isZonedDate,
  ORDER_ADDRESS_FIELDS,
  OrderSnapshot,
  QUANTITY_FIELDS,
} from './order-snapshot';

export function inspectOrder(snapshot: OrderSnapshot, now: number) {
  const errors: ErrorDetail[] = [];
  const missing = (field: string) => errors.push({ field, reason: 'required' });
  const invalid = (field: string, reason: string) => errors.push({ field, reason });
  if (!snapshot.paymentMethodType?.trim()) missing('paymentMethodType');
  else if (!['cat', 'billing', 'credit', 'groupBilling'].includes(snapshot.paymentMethodType))
    invalid('paymentMethodType', 'unsupported');
  if (!snapshot.pickupRequestedAt?.trim()) missing('pickupRequestedAt');
  else if (!isZonedDate(snapshot.pickupRequestedAt)) invalid('pickupRequestedAt', 'zonedDateTime');
  else if (Date.parse(snapshot.pickupRequestedAt) <= now)
    invalid('pickupRequestedAt', 'mustBeFuture');
  if (!snapshot.parcels.length) missing('parcels');
  for (const [index, parcel] of snapshot.parcels.entries()) {
    const prefix = `parcels.${index}`;
    for (const side of ['origin', 'destination'] as const) {
      const address = parcel[side];
      for (const field of ORDER_ADDRESS_FIELDS) {
        if (field === 'detailAddress') continue;
        const value = address[field];
        if (value === null || (typeof value === 'string' && !value.trim()))
          missing(`${prefix}.${side}.${field}`);
      }
      if (address.phoneNumber?.trim() && !/^[0-9]+$/.test(address.phoneNumber))
        invalid(`${prefix}.${side}.phoneNumber`, 'digitsOnly');
      if (address.postalCode?.trim() && !/^[0-9]{5}$/.test(address.postalCode))
        invalid(`${prefix}.${side}.postalCode`, 'postalCode');
      if (address.latitude !== null && (address.latitude < -90 || address.latitude > 90))
        invalid(`${prefix}.${side}.latitude`, 'latitudeRange');
      if (address.longitude !== null && (address.longitude < -180 || address.longitude > 180))
        invalid(`${prefix}.${side}.longitude`, 'longitudeRange');
    }
    for (const field of QUANTITY_FIELDS) {
      const value = parcel[field];
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 2147483647))
        invalid(`${prefix}.${field}`, 'quantityRange');
    }
    if (
      !QUANTITY_FIELDS.some((field) => (parcel[field] ?? 0) > 0) &&
      !parcel.otherItemDescription?.trim()
    )
      missing(`${prefix}.items`);
    if (parcel.itemPrice === null) missing(`${prefix}.itemPrice`);
    else if (!Number.isSafeInteger(parcel.itemPrice) || parcel.itemPrice < 0)
      invalid(`${prefix}.itemPrice`, 'priceRange');
    if (parcel.notifiedPrice !== null && parcel.notifiedPrice !== 3500)
      invalid(`${prefix}.notifiedPrice`, 'fixedPrice3500');
  }
  const collectedFields: string[] = [];
  const collect = (value: unknown, path: string): void => {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim()))
      return;
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value))
        collect(child, path ? `${path}.${key}` : key);
    } else collectedFields.push(path);
  };
  collect(snapshot, '');
  return {
    collectedFields,
    missingFields: errors
      .filter((error) => error.reason === 'required')
      .map((error) => error.field),
    errors,
  };
}

export function assertOrderSubmissionReady(snapshot: OrderSnapshot, now = Date.now()): void {
  const { errors } = inspectOrder(snapshot, now);
  if (errors.length)
    throw new ApiException(
      422,
      'VALIDATION_FAILED',
      '접수에 필요한 주문 정보를 확인해 주세요.',
      errors,
    );
}
