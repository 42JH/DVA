const text = (value: unknown): string => String(value);

export interface PaymentEnvironment {
  ORDER_PAYMENTS_ENABLED: boolean;
  PAYMENT_PUBLIC_URL: string;
  PAYMENT_TOSS_BASE_URL: string;
  TOSS_TEST_CLIENT_KEY?: string;
  TOSS_TEST_SECRET_KEY?: string;
  PAYMENT_MATTERMOST_WEBHOOK_URL?: string;
}

export function paymentEnvironment(
  raw: Record<string, unknown>,
  errors: string[],
): PaymentEnvironment {
  const flag = raw.ORDER_PAYMENTS_ENABLED ?? 'false';
  if (flag !== 'true' && flag !== 'false') errors.push('ORDER_PAYMENTS_ENABLED');
  const enabled = flag === 'true';
  const local = raw.NODE_ENV === 'test';
  const url = (key: string, fallback: string, publicPage = false) => {
    const value = text(raw[key] || fallback);
    if (!value && !enabled) return value;
    try {
      const parsed = new URL(value);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
      if (
        (parsed.protocol !== 'https:' && !(local && loopback && parsed.protocol === 'http:')) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        errors.push(key);
      if (
        publicPage &&
        (parsed.pathname !== '/api/payments' ||
          !text(raw.CORS_ORIGINS || '')
            .split(',')
            .map((s) => s.trim())
            .includes(parsed.origin))
      )
        errors.push(key);
      if (
        key === 'PAYMENT_TOSS_BASE_URL' &&
        value !== 'https://api.tosspayments.com' &&
        !(local && loopback)
      )
        errors.push(key);
      if (
        key === 'PAYMENT_MATTERMOST_WEBHOOK_URL' &&
        !local &&
        !/^\/hooks\/[A-Za-z0-9_-]+$/.test(parsed.pathname)
      )
        errors.push(key);
    } catch {
      errors.push(key);
    }
    return value;
  };
  const key = (name: string, prefix: string) => {
    const value = raw[name];
    if (
      (enabled || value) &&
      (typeof value !== 'string' || !new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(value))
    )
      errors.push(name);
    return typeof value === 'string' && value ? value : undefined;
  };
  return {
    ORDER_PAYMENTS_ENABLED: enabled,
    PAYMENT_PUBLIC_URL: url('PAYMENT_PUBLIC_URL', '', true),
    PAYMENT_TOSS_BASE_URL: url('PAYMENT_TOSS_BASE_URL', 'https://api.tosspayments.com'),
    TOSS_TEST_CLIENT_KEY: key('TOSS_TEST_CLIENT_KEY', 'test_gck_'),
    TOSS_TEST_SECRET_KEY: key('TOSS_TEST_SECRET_KEY', 'test_gsk_'),
    PAYMENT_MATTERMOST_WEBHOOK_URL: url('PAYMENT_MATTERMOST_WEBHOOK_URL', '') || undefined,
  };
}
