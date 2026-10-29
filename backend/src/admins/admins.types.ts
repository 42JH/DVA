export const ADMIN_ROLES = ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const ASSIGNABLE_ADMIN_ROLES = ['OPERATOR', 'SUPERVISOR'] as const;
export type AssignableAdminRole = (typeof ASSIGNABLE_ADMIN_ROLES)[number];
export const ADMIN_STATUSES = ['ACTIVE', 'PENDING', 'INACTIVE'] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];
export interface AdminAccount {
  adminUserSeq: number;
  loginId: string;
  name: string;
  role: AdminRole;
  status: AdminStatus;
  createdAt: Date;
  lastLoginAt: Date | null;
  passwordHash: string;
}
export type AdminPublic = Omit<AdminAccount, 'passwordHash'>;
export function publicAdmin(account: AdminAccount): AdminPublic {
  return {
    adminUserSeq: account.adminUserSeq,
    loginId: account.loginId,
    name: account.name,
    role: account.role,
    status: account.status,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
  };
}
