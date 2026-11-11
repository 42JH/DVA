import type { RecipientReceipt } from "./order-recipient-pins.cjs";
export const ORDER_CREATION_LOCK: number;
export interface CreatedOrderCustomer {
  customerSeq: number;
  name: string;
  phoneNumber: string;
  status: "ACTIVE";
  monthlyBillingEnabled: false;
  address: null;
}
export interface CustomerCreationReceipt {
  eventId: string;
  payload: {
    writeEventId: string;
    customer: CreatedOrderCustomer;
    adminId: number | null;
    requestId: string;
  };
}
export type CustomerPreparationOutcome =
  | { status: "PENDING" | "ABORTED" }
  | {
      status: "COMMITTED";
      customerCreationReceipt: CustomerCreationReceipt;
      recipientReceipt: RecipientReceipt | null;
    };
export function customerPreparationId(phone: string): string;
export function validateCreatedCustomer(
  value: unknown,
): asserts value is CreatedOrderCustomer;
export function validateCustomerCreationReceipt(
  value: unknown,
): asserts value is CustomerCreationReceipt;
export function validateCustomerPreparationOutcome(
  value: unknown,
): asserts value is CustomerPreparationOutcome;
