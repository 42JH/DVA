export const CALL_COMPLAINT_TYPES = [
  'REPEATED_QUESTION',
  'SPEAKING_TOO_FAST',
  'RECOGNITION_FAILURE',
  'SLOW_RESPONSE',
  'AI_REFUSAL',
  'INFORMATION_RECOGNITION_ERROR',
  'INTENT_RECOGNITION_ERROR',
  'UNSUPPORTED_ANSWER',
  'INTERRUPTION',
  'DISSATISFACTION_EXPRESSION',
] as const;

export type CallComplaintType = (typeof CALL_COMPLAINT_TYPES)[number];

export const CALL_COMPLAINT_TARGETS = [
  'ai_service',
  'price_policy',
  'delivery_other',
] as const;
export const CALL_COMPLAINT_LEVELS = ['explicit', 'mild'] as const;
export type CallComplaintTarget = (typeof CALL_COMPLAINT_TARGETS)[number];
export type CallComplaintLevel = (typeof CALL_COMPLAINT_LEVELS)[number];
