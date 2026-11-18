import { randomBytes } from 'node:crypto';
import { privateAddress } from '@dva/events/call-event-reference.cjs';
import { paymentEnvironment, PaymentEnvironment } from '../payments/payment-config';
const developmentSecurityLogKey = randomBytes(32).toString('hex');
export interface Environment extends PaymentEnvironment {
  AUTH_PROXY_HOPS: number;
  SECURITY_LOG_HMAC_KEY: string;
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  MSA_INSTANCE_IP?: string;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  CORS_ORIGINS: string[];
  SWAGGER_ENABLED: boolean;
  OPERATIONS_URL: string;
  CUSTOMER_AUTH_TOKEN: string;
  AI_BUSINESS_TOKEN?: string;
  CONSULTATION_URL: string;
  CUSTOMER_URL: string;
  DELIVERY_URL: string;
  DVER_API_URL: string;
  DVER_API_KEY?: string;
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
  const businessToken = raw.AI_BUSINESS_TOKEN;
  if (
    businessToken !== undefined &&
    businessToken !== '' &&
    (typeof businessToken !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(businessToken))
  )
    errors.push('AI_BUSINESS_TOKEN');
  const dverSetting = raw.DVER_API_URL ?? 'https://purple-wood-25a4.summer2.workers.dev';
  const dverUrl = typeof dverSetting === 'string' ? dverSetting : '';
  try {
    const url = new URL(dverUrl);
    if (
      (url.protocol !== 'https:' &&
        !(
          nodeEnv === 'test' &&
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      errors.push('DVER_API_URL');
  } catch {
    errors.push('DVER_API_URL');
  }
  const dverKey = raw.DVER_API_KEY;
  if (
    dverKey !== undefined &&
    dverKey !== '' &&
    (typeof dverKey !== 'string' || !/^[\x21-\x7e]+$/.test(dverKey))
  )
    errors.push('DVER_API_KEY');
  const config: Environment = {
    ...paymentEnvironment(raw, errors),
    AUTH_PROXY_HOPS: Number(authProxyHops),
    SECURITY_LOG_HMAC_KEY:
      typeof securityLogKey === 'string' && securityLogKey
        ? securityLogKey
        : developmentSecurityLogKey,
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    MSA_INSTANCE_IP:
      typeof raw.MSA_INSTANCE_IP === 'string' && raw.MSA_INSTANCE_IP
        ? raw.MSA_INSTANCE_IP
        : undefined,
    PORT: port('PORT', 3002),
    DB_HOST: required('DB_HOST'),
    DB_PORT: port('DB_PORT', 5432),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    CORS_ORIGINS: origins,
    SWAGGER_ENABLED: swagger === 'true',
    OPERATIONS_URL: required('OPERATIONS_URL'),
    CUSTOMER_AUTH_TOKEN: required('CUSTOMER_AUTH_TOKEN'),
    AI_BUSINESS_TOKEN:
      typeof businessToken === 'string' && businessToken ? businessToken : undefined,
    CONSULTATION_URL: required('CONSULTATION_URL'),
    CUSTOMER_URL: required('CUSTOMER_URL'),
    DELIVERY_URL: required('DELIVERY_URL'),
    DVER_API_URL: dverUrl,
    DVER_API_KEY: typeof dverKey === 'string' && dverKey ? dverKey : undefined,
  };
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
  for (const key of ['CONSULTATION_URL', 'CUSTOMER_URL', 'DELIVERY_URL'] as const) {
    try {
      const url = new URL(config[key]);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.origin !== config[key] ||
        url.username ||
        url.password
      )
        errors.push(key);
    } catch {
      errors.push(key);
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
