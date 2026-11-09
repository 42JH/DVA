const durationBuckets = [0.01, 0.05, 0.1, 0.5, 1, 2, 5];
type Sample = {
  route: string;
  method: string;
  status: number;
  count: number;
  duration: number;
  buckets: number[];
};
const samples = new Map<string, Sample>();
let submissionErrors = 0;
export function recordHttp(
  route: string,
  method: string,
  status: number,
  durationMs: number,
): void {
  if (route === '/internal/metrics' || route.startsWith('/health')) return;
  method = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)
    ? method
    : 'OTHER';
  if (
    method === 'POST' &&
    status >= 500 &&
    ['/api/admin/orders', '/api/orders', '/api/orders/:id/submit'].includes(
      route,
    )
  )
    submissionErrors++;
  // 외부 요청 수/임의 경로에 비례해 시계열이 늘지 않도록 제한한다.
  let key = `${route}|${method}|${status}`;
  if (!samples.has(key) && samples.size >= 256) {
    route = 'other';
    method = 'OTHER';
    status = Math.floor(status / 100) * 100;
    key = `${route}|${method}|${status}`;
  }
  const sample = samples.get(key) ?? {
    route,
    method,
    status,
    count: 0,
    duration: 0,
    buckets: durationBuckets.map(() => 0),
  };
  const seconds = Math.max(0, durationMs) / 1000;
  sample.count++;
  sample.duration += seconds;
  durationBuckets.forEach((limit, index) => {
    if (seconds <= limit) sample.buckets[index]++;
  });
  samples.set(key, sample);
}
export function httpMetrics(): string {
  const lines = [
    '# TYPE dva_http_requests_total counter',
    '# TYPE dva_http_request_duration_seconds histogram',
  ];
  for (const value of samples.values()) {
    const labels = `route=${JSON.stringify(value.route)},method="${value.method}",status="${value.status}"`;
    lines.push(
      `dva_http_requests_total{${labels}} ${value.count}`,
      `dva_http_request_duration_seconds_sum{${labels}} ${value.duration}`,
      `dva_http_request_duration_seconds_count{${labels}} ${value.count}`,
    );
    durationBuckets.forEach((limit, index) => {
      lines.push(
        `dva_http_request_duration_seconds_bucket{${labels},le="${limit}"} ${value.buckets[index]}`,
      );
    });
    lines.push(
      `dva_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${value.count}`,
    );
  }
  lines.push(
    '# TYPE dva_submission_http_errors_total counter',
    `dva_submission_http_errors_total ${submissionErrors}`,
  );
  return lines.join('\n') + '\n';
}
