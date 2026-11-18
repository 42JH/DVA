export const UNANSWERED_QUESTION_REASONS = ['KB_NO_ANSWER', 'KB_UNAVAILABLE'] as const;

export type UnansweredQuestionReason = (typeof UNANSWERED_QUESTION_REASONS)[number];
