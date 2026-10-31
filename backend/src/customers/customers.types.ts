import { CustomerAddressDto } from './dto/customer-address.dto';

export const CUSTOMER_STATUSES = ['ACTIVE', 'WITHDRAWN'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export interface Customer {
  address: CustomerAddressDto | null;
  monthlyBillingEnabled: boolean;
  customerSeq: number;
  name: string;
  phoneNumber: string;
  status: CustomerStatus;
}
