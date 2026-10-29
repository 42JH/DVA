export const ORGANIZATION_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export interface Organization {
  monthlyBillingEnabled: boolean;
  organizationSeq: number;
  name: string;
  status: OrganizationStatus;
}
