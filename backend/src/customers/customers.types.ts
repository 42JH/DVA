export const CUSTOMER_STATUSES = ['ACTIVE', 'WITHDRAWN'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export interface Customer {
  customerSeq: number;
  name: string;
  phoneNumber: string;
  status: CustomerStatus;
}
