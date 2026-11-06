export const RECORDING_RETRY_MINUTES = [1, 5, 15, 30];
export const RECORDING_MAX_ATTEMPTS = RECORDING_RETRY_MINUTES.length + 1;

type RecordingFailureCode =
  | 'SOURCE_NOT_ALLOWED'
  | 'ADDRESS_NOT_PUBLIC'
  | 'OBJECT_CONFLICT'
  | 'DOWNLOAD_REJECTED'
  | 'CONTENT_TYPE_REJECTED'
  | 'TOO_LARGE'
  | 'DOWNLOAD_INCOMPLETE'
  | 'DOWNLOAD_UNAVAILABLE'
  | 'SOURCE_ACCESS_DENIED'
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_RATE_LIMITED'
  | 'SOURCE_UNAVAILABLE'
  | 'STORAGE_UNAVAILABLE'
  | 'PAYLOAD_INVALID'
  | 'PROCESSING_UNAVAILABLE'
  | 'ATTEMPT_INTERRUPTED';

export class RecordingProcessingError extends Error {
  constructor(
    readonly code: RecordingFailureCode,
    readonly retryable = true,
  ) {
    super('recording_' + code.toLowerCase());
  }
}
