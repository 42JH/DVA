export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  AI_AGENT_URL: string;
  AI_PERSONA_TOKEN?: string;
  CORS_ORIGINS: string[];
  SWAGGER_ENABLED: boolean;
  PBX_WEBHOOK_TOKEN?: string;
  DVER_API_URL: string;
  DVER_API_KEY?: string;
  AWS_REGION: string;
  S3_RECORDINGS_BUCKET?: string;
  RECORDING_ALLOWED_HOSTS: string[];
  RECORDING_MATCH_WINDOW_SECONDS: number;
}

export class EnvironmentValidationError extends Error {
  constructor(fields: string[]) {
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
  if (!['development', 'test', 'production'].includes(String(nodeEnv))) errors.push('NODE_ENV');
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
  const personaToken = raw.AI_PERSONA_TOKEN;
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
  const dverUrl = raw.DVER_API_URL ?? 'https://public-n8n.dvercorp.co.kr:47514/webhook/parcel';
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
  const dverKey = raw.DVER_API_KEY;
  if (
    dverKey !== undefined &&
    dverKey !== '' &&
    (typeof dverKey !== 'string' || !/^[\x21-\x7e]+$/.test(dverKey))
  )
    errors.push('DVER_API_KEY');
  const config: Environment = {
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    PORT: port('PORT', 3000),
    DB_HOST: required('DB_HOST'),
    DB_PORT: port('DB_PORT', 5432),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    AI_AGENT_URL: aiUrl.replace(/\/$/, ''),
    AI_PERSONA_TOKEN: typeof personaToken === 'string' && personaToken ? personaToken : undefined,
    CORS_ORIGINS: [...new Set(origins)],
    SWAGGER_ENABLED: swagger === 'true',
    PBX_WEBHOOK_TOKEN: typeof token === 'string' && token ? token : undefined,
    DVER_API_URL: String(dverUrl),
    DVER_API_KEY: typeof dverKey === 'string' && dverKey ? dverKey : undefined,
    AWS_REGION: String(raw.AWS_REGION || 'ap-northeast-2'),
    S3_RECORDINGS_BUCKET:
      typeof raw.S3_RECORDINGS_BUCKET === 'string' && raw.S3_RECORDINGS_BUCKET
        ? raw.S3_RECORDINGS_BUCKET
        : undefined,
    RECORDING_ALLOWED_HOSTS: String(
      raw.RECORDING_ALLOWED_HOSTS ||
        'dvercorp-aicc-connect-dev-recordings.s3.ap-northeast-2.amazonaws.com',
    )
      .split(',')
      .map((host) => host.trim().toLowerCase()),
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
