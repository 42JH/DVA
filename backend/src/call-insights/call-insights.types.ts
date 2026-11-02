export const CALL_COMPLAINT_TYPES = [
  'REPEATED_QUESTION',
  'SPEAKING_TOO_FAST',
  'RECOGNITION_FAILURE',
  'SLOW_RESPONSE',
  'AI_REFUSAL',
] as const;

export type CallComplaintType = (typeof CALL_COMPLAINT_TYPES)[number];
