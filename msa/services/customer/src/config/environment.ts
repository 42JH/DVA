import { randomBytes } from 'node:crypto';
import { privateAddress } from '@dva/events/call-event-reference.cjs';
const developmentSecurityLogKey = randomBytes(32).toString('hex');
export interface Environment {
  AUTH_PROXY_HOPS: number;
  SECURITY_LOG_HMAC_KEY: string;
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  MSA_INSTANCE_IP?: string;
  AI_BUSINESS_TOKEN?: string;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  CORS_ORIGINS: string[];
  SWAGGER_ENABLED: boolean;
  ORDER_URL?: string;
  OPERATIONS_URL: string;
  CUSTOMER_AUTH_TOKEN: string;
  CONSULTATION_AUTH_TOKEN?: string;
  CONSULTATION_URL?: string;
  TOSS_BILLING_SECRET_KEY?: string;
  PAYMENT_CARD_ENCRYPTION_KEY?: string;
  PAYMENT_TOSS_BASE_URL: string;
  ORDER_PAYMENTS_ENABLED: boolean;
}

export class EnvironmentValidationError extends Error {
  constructor(readonly fields: string[]) {
    super(`Invalid environment variables: ${[...new Set(fields)].join(', ')}`);
    this.name = 'EnvironmentValidationError';
  }
}

export function validateEnvironment(raw: Record<string, unknown>): Environment {
  const errors: string[] = [];
  const required = (key: string): string => {
    const value = raw[key];
    if (typeof value !== 'string' || !value.trim()) {
      errors.push(key);
      return '';
    }
    return value;
  };
  const port = (key: string, fallback: number): number => {
    const value = raw[key] ?? String(fallback);
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      errors.push(key);
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) errors.push(key);
    return parsed;
  };
  const businessToken = raw.AI_BUSINESS_TOKEN;
  if (
    businessToken !== undefined &&
    businessToken !== '' &&
    (typeof businessToken !== 'string' ||
      businessToken.length < 32 ||
      !/^[\x21-\x7e]+$/.test(businessToken))
  )
    errors.push('AI_BUSINESS_TOKEN');
  const nodeEnv = raw.NODE_ENV ?? 'development';
  if (typeof nodeEnv !== 'string' || !['development', 'test', 'production'].includes(nodeEnv))
    errors.push('NODE_ENV');
  const origins =
    typeof raw.CORS_ORIGINS === 'string'
      ? raw.CORS_ORIGINS.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : [];
  if (raw.CORS_ORIGINS !== undefined && typeof raw.CORS_ORIGINS !== 'string')
    errors.push('CORS_ORIGINS');
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
        errors.push('CORS_ORIGINS');
    } catch {
      errors.push('CORS_ORIGINS');
    }
  }
  const swagger = raw.SWAGGER_ENABLED ?? 'true';
  if (swagger !== 'true' && swagger !== 'false') errors.push('SWAGGER_ENABLED');
  const orderPayments = raw.ORDER_PAYMENTS_ENABLED ?? 'false';
  if (orderPayments !== 'true' && orderPayments !== 'false') errors.push('ORDER_PAYMENTS_ENABLED');
  const authProxyHops = raw.AUTH_PROXY_HOPS ?? '0';
  if (typeof authProxyHops !== 'string' || !/^[012]$/.test(authProxyHops))
    errors.push('AUTH_PROXY_HOPS');
  const securityLogKey = raw.SECURITY_LOG_HMAC_KEY;
  if (
    (nodeEnv === 'production' && !securityLogKey) ||
    (securityLogKey !== undefined &&
      securityLogKey !== '' &&
      (typeof securityLogKey !== 'string' || !/^[a-fA-F0-9]{64}$/.test(securityLogKey)))
  )
    errors.push('SECURITY_LOG_HMAC_KEY');
  const config: Environment = {
    AUTH_PROXY_HOPS: Number(authProxyHops),
    SECURITY_LOG_HMAC_KEY:
      typeof securityLogKey === 'string' && securityLogKey
        ? securityLogKey
        : developmentSecurityLogKey,
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    AI_BUSINESS_TOKEN:
      typeof businessToken === 'string' && businessToken ? businessToken : undefined,
    MSA_INSTANCE_IP:
      typeof raw.MSA_INSTANCE_IP === 'string' && raw.MSA_INSTANCE_IP
        ? raw.MSA_INSTANCE_IP
        : undefined,
    PORT: port('PORT', 3001),
    DB_HOST: required('DB_HOST'),
    DB_PORT: port('DB_PORT', 5432),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    CORS_ORIGINS: origins,
    SWAGGER_ENABLED: swagger === 'true',
    ORDER_PAYMENTS_ENABLED: orderPayments === 'true',
    ORDER_URL: typeof raw.ORDER_URL === 'string' ? raw.ORDER_URL : undefined,
    OPERATIONS_URL: required('OPERATIONS_URL'),
    CUSTOMER_AUTH_TOKEN: required('CUSTOMER_AUTH_TOKEN'),
    CONSULTATION_URL: typeof raw.CONSULTATION_URL === 'string' ? raw.CONSULTATION_URL : undefined,
    CONSULTATION_AUTH_TOKEN:
      typeof raw.CONSULTATION_AUTH_TOKEN === 'string' ? raw.CONSULTATION_AUTH_TOKEN : undefined,
    TOSS_BILLING_SECRET_KEY:
      typeof raw.TOSS_BILLING_SECRET_KEY === 'string' && raw.TOSS_BILLING_SECRET_KEY
        ? raw.TOSS_BILLING_SECRET_KEY
        : undefined,
    PAYMENT_CARD_ENCRYPTION_KEY:
      typeof raw.PAYMENT_CARD_ENCRYPTION_KEY === 'string' && raw.PAYMENT_CARD_ENCRYPTION_KEY
        ? raw.PAYMENT_CARD_ENCRYPTION_KEY
        : undefined,
    PAYMENT_TOSS_BASE_URL: String(
      (raw.PAYMENT_TOSS_BASE_URL as string | undefined) || 'https://api.tosspayments.com',
    ),
  };
  const billingSecret = raw.TOSS_BILLING_SECRET_KEY;
  const cardEncryption = raw.PAYMENT_CARD_ENCRYPTION_KEY;
  if (
    billingSecret &&
    (typeof billingSecret !== 'string' || !/^(?:test|live)_sk_[A-Za-z0-9_-]+$/.test(billingSecret))
  )
    errors.push('TOSS_BILLING_SECRET_KEY');
  if (
    cardEncryption &&
    (typeof cardEncryption !== 'string' || !/^[a-fA-F0-9]{64}$/.test(cardEncryption))
  )
    errors.push('PAYMENT_CARD_ENCRYPTION_KEY');
  if (config.PAYMENT_TOSS_BASE_URL || raw.ORDER_PAYMENTS_ENABLED === 'true') {
    try {
      const url = new URL(config.PAYMENT_TOSS_BASE_URL);
      const local =
        nodeEnv === 'test' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (config.PAYMENT_TOSS_BASE_URL !== 'https://api.tosspayments.com' && !local)
      )
        errors.push('PAYMENT_TOSS_BASE_URL');
    } catch {
      errors.push('PAYMENT_TOSS_BASE_URL');
    }
  }
  try {
    const url = new URL(config.OPERATIONS_URL);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== config.OPERATIONS_URL ||
      url.username ||
      url.password
    )
      errors.push('OPERATIONS_URL');
  } catch {
    errors.push('OPERATIONS_URL');
  }
  if (!/^[\x21-\x7e]{32,256}$/.test(config.CUSTOMER_AUTH_TOKEN)) errors.push('CUSTOMER_AUTH_TOKEN');
  if (
    raw.CONSULTATION_AUTH_TOKEN !== undefined &&
    (typeof raw.CONSULTATION_AUTH_TOKEN !== 'string' ||
      !/^[\x21-\x7e]{32,256}$/.test(raw.CONSULTATION_AUTH_TOKEN))
  )
    errors.push('CONSULTATION_AUTH_TOKEN');
  if (raw.CONSULTATION_URL !== undefined) {
    try {
      if (typeof raw.CONSULTATION_URL !== 'string') throw new Error();
      const url = new URL(raw.CONSULTATION_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== raw.CONSULTATION_URL)
        errors.push('CONSULTATION_URL');
    } catch {
      errors.push('CONSULTATION_URL');
    }
  }
  if (raw.ORDER_URL !== undefined) {
    try {
      if (typeof raw.ORDER_URL !== 'string') throw new Error();
      const url = new URL(raw.ORDER_URL);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== raw.ORDER_URL ||
        url.username ||
        url.password
      )
        errors.push('ORDER_URL');
    } catch {
      errors.push('ORDER_URL');
    }
  }
  if (
    raw.MSA_INSTANCE_IP !== undefined &&
    raw.MSA_INSTANCE_IP !== '' &&
    !privateAddress(raw.MSA_INSTANCE_IP)
  )
    errors.push('MSA_INSTANCE_IP');
  if (errors.length) throw new EnvironmentValidationError(errors);
  return config;
}
