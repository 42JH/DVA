import { PaymentEnvironment, paymentEnvironment } from '../payments/payment-config';
import { randomBytes } from 'node:crypto';
const developmentSecurityLogKey = randomBytes(32).toString('hex');
export interface Environment extends PaymentEnvironment {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  AUTH_PROXY_HOPS: number;
  SECURITY_LOG_HMAC_KEY: string;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  AI_AGENT_URL: string;
  AI_BUSINESS_TOKEN?: string;
  AI_PERSONA_TOKEN?: string;
  PERSONA_CHECK_URL?: string;
  PERSONA_CHECK_TOKEN?: string;
  AI_FAQ_TOKEN?: string;
  AI_INSIGHTS_TOKEN?: string;
  // 통화 불만 판정(후처리) 전용 OpenAI 키 — 실시간 상담 키와 따로. 없으면 판정 워커가 꺼짐
  CALL_ANALYSIS_OPENAI_API_KEY?: string;
  CALL_ANALYSIS_CONCURRENCY: number;
  CORS_ORIGINS: string[];
  SWAGGER_ENABLED: boolean;
  PBX_WEBHOOK_TOKEN?: string;
  DVER_API_URL?: string;
  DVER_API_KEY?: string;
  AWS_REGION: string;
  S3_RECORDINGS_BUCKET?: string;
  RECORDING_ALLOWED_HOSTS: string[];
  RECORDING_MATCH_WINDOW_SECONDS: number;
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
  const authProxyHops = raw.AUTH_PROXY_HOPS ?? '0';
  if (typeof authProxyHops !== 'string' || !/^[012]$/.test(authProxyHops))
    errors.push('AUTH_PROXY_HOPS');
  if (!['development', 'test', 'production'].includes(String(nodeEnv))) errors.push('NODE_ENV');
  const securityLogKey = raw.SECURITY_LOG_HMAC_KEY;
  if (
    (nodeEnv === 'production' && !securityLogKey) ||
    (securityLogKey !== undefined &&
      securityLogKey !== '' &&
      (typeof securityLogKey !== 'string' || !/^[a-fA-F0-9]{64}$/.test(securityLogKey)))
  )
    errors.push('SECURITY_LOG_HMAC_KEY');
  const aiUrl = required('AI_AGENT_URL');
  try {
    const url = new URL(aiUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      errors.push('AI_AGENT_URL');
    }
  } catch {
    errors.push('AI_AGENT_URL');
  }
  let personaCheckUrl: string | undefined;
  if (raw.PERSONA_CHECK_URL !== undefined && raw.PERSONA_CHECK_URL !== '') {
    try {
      const url = new URL(String(raw.PERSONA_CHECK_URL));
      if (
        typeof raw.PERSONA_CHECK_URL !== 'string' ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        errors.push('PERSONA_CHECK_URL');
      else personaCheckUrl = url.origin;
    } catch {
      errors.push('PERSONA_CHECK_URL');
    }
  }
  const personaCheckToken = raw.PERSONA_CHECK_TOKEN;
  if (
    personaCheckToken !== undefined &&
    personaCheckToken !== '' &&
    (typeof personaCheckToken !== 'string' || !/^[a-fA-F0-9]{64}$/.test(personaCheckToken))
  )
    errors.push('PERSONA_CHECK_TOKEN');
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
  const swagger = raw.SWAGGER_ENABLED ?? (nodeEnv === 'development' ? 'true' : 'false');
  if (swagger !== 'true' && swagger !== 'false') errors.push('SWAGGER_ENABLED');
  const token = raw.PBX_WEBHOOK_TOKEN;
  const businessToken = raw.AI_BUSINESS_TOKEN;
  const personaToken = raw.AI_PERSONA_TOKEN;
  const faqToken = raw.AI_FAQ_TOKEN;
  const insightsToken = raw.AI_INSIGHTS_TOKEN;
  const analysisKey = raw.CALL_ANALYSIS_OPENAI_API_KEY;
  if (
    analysisKey !== undefined &&
    analysisKey !== '' &&
    (typeof analysisKey !== 'string' ||
      analysisKey.length < 20 ||
      !/^[\x21-\x7e]+$/.test(analysisKey))
  )
    errors.push('CALL_ANALYSIS_OPENAI_API_KEY');
  const analysisConcurrency = raw.CALL_ANALYSIS_CONCURRENCY ?? '2';
  if (typeof analysisConcurrency !== 'string' || !/^[1-4]$/.test(analysisConcurrency))
    errors.push('CALL_ANALYSIS_CONCURRENCY');
  if (
    businessToken !== undefined &&
    businessToken !== '' &&
    (typeof businessToken !== 'string' ||
      businessToken.length < 32 ||
      !/^[\x21-\x7e]+$/.test(businessToken))
  )
    errors.push('AI_BUSINESS_TOKEN');
  if (
    insightsToken !== undefined &&
    insightsToken !== '' &&
    (typeof insightsToken !== 'string' ||
      insightsToken.length < 32 ||
      !/^[\x21-\x7e]+$/.test(insightsToken))
  )
    errors.push('AI_INSIGHTS_TOKEN');
  if (
    faqToken !== undefined &&
    faqToken !== '' &&
    (typeof faqToken !== 'string' || faqToken.length < 32 || !/^[\x21-\x7e]+$/.test(faqToken))
  )
    errors.push('AI_FAQ_TOKEN');
  if (
    personaToken !== undefined &&
    personaToken !== '' &&
    (typeof personaToken !== 'string' ||
      personaToken.length < 32 ||
      !/^[\x21-\x7e]+$/.test(personaToken))
  )
    errors.push('AI_PERSONA_TOKEN');
  if (
    token !== undefined &&
    token !== '' &&
    (typeof token !== 'string' || Buffer.byteLength(token) < 32 || /\s/.test(token))
  ) {
    errors.push('PBX_WEBHOOK_TOKEN');
  }
  const dverUrl = raw.DVER_API_URL;
  if (dverUrl !== undefined && dverUrl !== '') {
    try {
      const url = new URL(String(dverUrl));
      if (
        typeof dverUrl !== 'string' ||
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
  }
  const dverKey = raw.DVER_API_KEY;
  if (
    dverKey !== undefined &&
    dverKey !== '' &&
    (typeof dverKey !== 'string' || !/^[\x21-\x7e]+$/.test(dverKey))
  )
    errors.push('DVER_API_KEY');
  const recordingHosts = raw.RECORDING_ALLOWED_HOSTS;
  if (recordingHosts !== undefined && typeof recordingHosts !== 'string')
    errors.push('RECORDING_ALLOWED_HOSTS');
  const config: Environment = {
    ...paymentEnvironment(raw, errors),
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    PORT: port('PORT', 3000),
    AUTH_PROXY_HOPS: Number(authProxyHops),
    SECURITY_LOG_HMAC_KEY:
      typeof securityLogKey === 'string' && securityLogKey
        ? securityLogKey
        : developmentSecurityLogKey,
    DB_HOST: required('DB_HOST'),
    DB_PORT: port('DB_PORT', 5432),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    AI_AGENT_URL: aiUrl.replace(/\/$/, ''),
    AI_BUSINESS_TOKEN:
      typeof businessToken === 'string' && businessToken ? businessToken : undefined,
    AI_PERSONA_TOKEN: typeof personaToken === 'string' && personaToken ? personaToken : undefined,
    PERSONA_CHECK_URL: personaCheckUrl,
    PERSONA_CHECK_TOKEN:
      typeof personaCheckToken === 'string' && personaCheckToken ? personaCheckToken : undefined,
    AI_FAQ_TOKEN: typeof faqToken === 'string' && faqToken ? faqToken : undefined,
    CALL_ANALYSIS_OPENAI_API_KEY:
      typeof analysisKey === 'string' && analysisKey ? analysisKey : undefined,
    CALL_ANALYSIS_CONCURRENCY: Number(analysisConcurrency) || 2,
    AI_INSIGHTS_TOKEN:
      typeof insightsToken === 'string' && insightsToken ? insightsToken : undefined,
    CORS_ORIGINS: [...new Set(origins)],
    SWAGGER_ENABLED: swagger === 'true',
    PBX_WEBHOOK_TOKEN: typeof token === 'string' && token ? token : undefined,
    DVER_API_URL: typeof dverUrl === 'string' && dverUrl ? dverUrl : undefined,
    DVER_API_KEY: typeof dverKey === 'string' && dverKey ? dverKey : undefined,
    AWS_REGION: String(raw.AWS_REGION || 'ap-northeast-2'),
    S3_RECORDINGS_BUCKET:
      typeof raw.S3_RECORDINGS_BUCKET === 'string' && raw.S3_RECORDINGS_BUCKET
        ? raw.S3_RECORDINGS_BUCKET
        : undefined,
    RECORDING_ALLOWED_HOSTS:
      typeof recordingHosts === 'string' && recordingHosts
        ? recordingHosts.split(',').map((host) => host.trim().toLowerCase())
        : [],
    RECORDING_MATCH_WINDOW_SECONDS: Number(raw.RECORDING_MATCH_WINDOW_SECONDS || '30'),
  };
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(config.AWS_REGION)) errors.push('AWS_REGION');
  if (
    raw.S3_RECORDINGS_BUCKET &&
    (typeof raw.S3_RECORDINGS_BUCKET !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.S3_RECORDINGS_BUCKET!))
  )
    errors.push('S3_RECORDINGS_BUCKET');
  if (
    config.RECORDING_ALLOWED_HOSTS.some(
      (host) =>
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
        !host.includes('.') ||
        /^[\d.]+$/.test(host),
    )
  )
    errors.push('RECORDING_ALLOWED_HOSTS');
  if (
    !Number.isInteger(config.RECORDING_MATCH_WINDOW_SECONDS) ||
    config.RECORDING_MATCH_WINDOW_SECONDS < 1 ||
    config.RECORDING_MATCH_WINDOW_SECONDS > 300
  )
    errors.push('RECORDING_MATCH_WINDOW_SECONDS');
  if (errors.length) throw new EnvironmentValidationError(errors);
  return config;
}
