export const CALL_ANALYSIS_RESULTS = [
  'REGISTERED',
  'REGISTRATION_FAILED',
  'HANDOFF',
  'CANCELLED',
  'INQUIRY',
] as const;

export const CALL_COMPLAINT_TYPES = [
  'REPEATED_QUESTION',
  'SPEAKING_TOO_FAST',
  'RECOGNITION_FAILURE',
  'SLOW_RESPONSE',
  'AI_REFUSAL',
] as const;

export type CallAnalysisResult = (typeof CALL_ANALYSIS_RESULTS)[number];
export type CallComplaintType = (typeof CALL_COMPLAINT_TYPES)[number];
