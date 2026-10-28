export const HANDOFF_STATUSES = ['REQUESTED', 'CONNECTED', 'FAILED'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];
