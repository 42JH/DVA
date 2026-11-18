import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';

export function outboxMetrics(pool: Pool): Promise<string>;
export function metricsHandler(
  pool: Pool,
  httpMetrics: () => string,
): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export function createHttpTelemetry(): {
  observe: (request: IncomingMessage & { path: string }, response: ServerResponse, next: () => void) => void;
  metrics: () => string;
};
