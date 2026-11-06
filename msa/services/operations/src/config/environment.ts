import { randomBytes } from 'node:crypto';
const developmentSecurityLogKey = randomBytes(32).toString('hex');
export interface Environment {
  SECURITY_LOG_HMAC_KEY: string;
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  AI_BUSINESS_TOKEN?: string;
  AUTH_PROXY_HOPS: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  AI_AGENT_URL?: string;
  AI_PERSONA_TOKEN?: string;
  AI_FAQ_TOKEN?: string;
  CORS_ORIGINS: string[];
  SWAGGER_ENABLED: boolean;
  CUSTOMER_AUTH_TOKEN?: string;
  CONSULTATION_AUTH_TOKEN?: string;
  CUSTOMER_URL?: string;
  CONSULTATION_URL?: string;
  ORDER_URL?: string;
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
  const authProxyHops = raw.AUTH_PROXY_HOPS ?? '0';
  if (typeof authProxyHops !== 'string' || !/^[012]$/.test(authProxyHops))
    errors.push('AUTH_PROXY_HOPS');
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
  const aiUrl = raw.AI_AGENT_URL;
  if (aiUrl !== undefined) {
    try {
      if (typeof aiUrl !== 'string') throw new Error();
      const url = new URL(aiUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        errors.push('AI_AGENT_URL');
    } catch {
      errors.push('AI_AGENT_URL');
    }
  }
  const personaToken = raw.AI_PERSONA_TOKEN;
  if (
    personaToken !== undefined &&
    personaToken !== '' &&
    (typeof personaToken !== 'string' ||
      personaToken.length < 32 ||
      !/^[\x21-\x7e]+$/.test(personaToken))
  )
    errors.push('AI_PERSONA_TOKEN');
  const faqToken = raw.AI_FAQ_TOKEN;
  if (
    faqToken !== undefined &&
    faqToken !== '' &&
    (typeof faqToken !== 'string' || faqToken.length < 32 || !/^[\x21-\x7e]+$/.test(faqToken))
  )
    errors.push('AI_FAQ_TOKEN');
  if (faqToken && !aiUrl) errors.push('AI_AGENT_URL');
  const securityLogKey = raw.SECURITY_LOG_HMAC_KEY;
  if (
    (nodeEnv === 'production' && !securityLogKey) ||
    (securityLogKey !== undefined &&
      securityLogKey !== '' &&
      (typeof securityLogKey !== 'string' || !/^[a-fA-F0-9]{64}$/.test(securityLogKey)))
  )
    errors.push('SECURITY_LOG_HMAC_KEY');
  const config: Environment = {
    SECURITY_LOG_HMAC_KEY:
      typeof securityLogKey === 'string' && securityLogKey
        ? securityLogKey
        : developmentSecurityLogKey,
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    AI_BUSINESS_TOKEN:
      typeof businessToken === 'string' && businessToken ? businessToken : undefined,
    AUTH_PROXY_HOPS: Number(authProxyHops),
    PORT: port('PORT', 3005),
    DB_HOST: required('DB_HOST'),
    DB_PORT: port('DB_PORT', 5432),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    AI_AGENT_URL: typeof aiUrl === 'string' ? aiUrl.replace(/\/$/, '') : undefined,
    AI_PERSONA_TOKEN: typeof personaToken === 'string' && personaToken ? personaToken : undefined,
    AI_FAQ_TOKEN: typeof faqToken === 'string' && faqToken ? faqToken : undefined,
    CORS_ORIGINS: origins,
    SWAGGER_ENABLED: swagger === 'true',
    CUSTOMER_AUTH_TOKEN:
      typeof raw.CUSTOMER_AUTH_TOKEN === 'string' ? raw.CUSTOMER_AUTH_TOKEN : undefined,
    CUSTOMER_URL: typeof raw.CUSTOMER_URL === 'string' ? raw.CUSTOMER_URL : undefined,
    ORDER_URL: typeof raw.ORDER_URL === 'string' ? raw.ORDER_URL : undefined,
    CONSULTATION_URL: typeof raw.CONSULTATION_URL === 'string' ? raw.CONSULTATION_URL : undefined,
    CONSULTATION_AUTH_TOKEN:
      typeof raw.CONSULTATION_AUTH_TOKEN === 'string' ? raw.CONSULTATION_AUTH_TOKEN : undefined,
  };
  if (
    raw.CUSTOMER_AUTH_TOKEN !== undefined &&
    (typeof raw.CUSTOMER_AUTH_TOKEN !== 'string' ||
      !/^[\x21-\x7e]{32,256}$/.test(raw.CUSTOMER_AUTH_TOKEN))
  )
    errors.push('CUSTOMER_AUTH_TOKEN');
  if (raw.CUSTOMER_URL !== undefined) {
    try {
      if (typeof raw.CUSTOMER_URL !== 'string') throw new Error('Invalid customer origin');
      const url = new URL(raw.CUSTOMER_URL);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== raw.CUSTOMER_URL)
        errors.push('CUSTOMER_URL');
    } catch {
      errors.push('CUSTOMER_URL');
    }
  }
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
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== raw.ORDER_URL)
        errors.push('ORDER_URL');
    } catch {
      errors.push('ORDER_URL');
    }
  }
  if (errors.length) throw new EnvironmentValidationError(errors);
  return config;
}
