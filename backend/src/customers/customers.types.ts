import { CustomerAddressDto } from './dto/customer-address.dto';

export const CUSTOMER_STATUSES = ['ACTIVE', 'WITHDRAWN'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export type CustomerPaymentMethod = 'billing' | 'credit' | 'groupBilling';
export interface EmployeeCustomerIdentity {
  customerSeq?: number;
  name: string;
  phoneNumber: string;
  address?: CustomerAddressDto | null;
}
export interface Customer {
  address: CustomerAddressDto | null;
  monthlyBillingEnabled: boolean;
  customerSeq: number;
  name: string;
  phoneNumber: string;
  status: CustomerStatus;
}
