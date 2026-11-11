export type RecipientAddress = Record<
  | "name"
  | "phoneNumber"
  | "roadAddress"
  | "jibunAddress"
  | "detailAddress"
  | "dongName"
  | "postalCode",
  string
>;
export interface RecipientPin {
  personalPinSeq: number;
  label: string;
  address: RecipientAddress;
}
export interface RecipientReceipt {
  eventId: string;
  payload: {
    writeEventId: string;
    orderSeq: number;
    customerSeq: number;
    adminId: number | null;
    requestId: string;
    pins: RecipientPin[];
  };
}
export function validateRecipientAddresses(
  value: unknown,
): asserts value is RecipientAddress[];
export function validateRecipientPins(
  value: unknown,
): asserts value is RecipientPin[];
export function validateRecipientReceipt(
  value: unknown,
): asserts value is RecipientReceipt;
