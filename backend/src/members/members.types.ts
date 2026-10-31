export const MEMBER_ROLES = ['MEMBER', 'ORG_ADMIN'] as const;
export const MEMBER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
export interface Membership {
  departmentSeq: number | null;
  membershipSeq: number;
  customerSeq: number;
  organizationSeq: number;
  employeeNo: string;
  role: MemberRole;
  status: MemberStatus;
}
export interface MemberCandidate {
  customerSeq: number;
  name: string;
  phoneNumber: string;
  customerStatus: 'ACTIVE' | 'WITHDRAWN';
  membershipSeq: number | null;
  organizationSeq: number | null;
  employeeNo: string | null;
}
