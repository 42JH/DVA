export const PERSONA_STATUSES = ['ACTIVE', 'PENDING', 'INACTIVE'] as const;
export const TURN_WAIT_LEVELS = ['SHORT', 'NORMAL', 'LONG'] as const;
export const APPLY_ERRORS = ['INVALID_CONFIG', 'UNSUPPORTED_OPTIONS', 'APPLY_FAILED'] as const;
export type PersonaStatus = (typeof PERSONA_STATUSES)[number];
export type TurnWaitLevel = (typeof TURN_WAIT_LEVELS)[number];
export type ApplyError = (typeof APPLY_ERRORS)[number] | 'AI_UNAVAILABLE';

export interface PersonaSettings {
  name: string;
  promptText: string;
  voiceId: string | null;
  speakingRate: number | null;
  turnWaitLevel: TurnWaitLevel;
}

export interface PersonaVersion extends PersonaSettings {
  aiPersonaSeq: number;
  code: string;
  aiPersonaVersionSeq: number;
  version: number;
  status: PersonaStatus;
  createdByAdminUserSeq: number | null;
  createdByAdminUserName?: string | null;
  createdAt: Date;
  applicationId: string | null;
  requestedByAdminUserSeq: number | null;
  requestedAt: Date | null;
  appliedAt: Date | null;
  lastNotifiedAt: Date | null;
  applyErrorCode: ApplyError | null;
}

export interface Persona {
  aiPersonaSeq: number;
  code: string;
  latestVersion: PersonaVersion;
  headVersion: PersonaVersion | null;
  activeVersionSeq: number | null;
  pendingVersionSeq: number | null;
}

export interface AiCapabilities {
  voices: Array<{ id: string; label: string }>;
  speakingRate: { min: number | null; max: number | null };
  turnWaitLevels: TurnWaitLevel[];
}
