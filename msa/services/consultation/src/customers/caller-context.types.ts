// Customer owns the snapshot; consultation consumes only the logical customer reference.
export interface CallerContextDto {
  lookupStatus: 'REGISTERED' | 'UNREGISTERED' | 'WITHDRAWN';
  customer: { customerSeq: number } | null;
  membership: object | null;
  organization: object | null;
  department: object | null;
  availablePaymentMethods: unknown[];
  availableUsageTypes: unknown[];
  personalPins: unknown[];
  companyPins: unknown[];
}
