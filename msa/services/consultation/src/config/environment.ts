export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  CORS_ORIGINS: string[];
  SWAGGER_ENABLED: boolean;
  OPERATIONS_URL: string;
  CUSTOMER_URL: string;
  CUSTOMER_AUTH_TOKEN: string;
  CONSULTATION_AUTH_TOKEN: string;
  PBX_WEBHOOK_TOKEN?: string;
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
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
      errors.push(key);
    return parsed;
  };
  const nodeEnv = raw.NODE_ENV ?? 'development';
  if (
    typeof nodeEnv !== 'string' ||
    !['development', 'test', 'production'].includes(nodeEnv)
  )
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
  const token = raw.PBX_WEBHOOK_TOKEN;
  if (
    token !== undefined &&
    token !== '' &&
    (typeof token !== 'string' ||
      Buffer.byteLength(token) < 32 ||
      /\s/.test(token))
  ) {
    errors.push('PBX_WEBHOOK_TOKEN');
  }
  const config: Environment = {
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    PORT: port('PORT', 3004),
    DB_HOST: required('DB_HOST'),
    DB_PORT: port('DB_PORT', 5432),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    CORS_ORIGINS: origins,
    SWAGGER_ENABLED: swagger === 'true',
    OPERATIONS_URL: required('OPERATIONS_URL'),
    CUSTOMER_URL: required('CUSTOMER_URL'),
    CUSTOMER_AUTH_TOKEN: required('CUSTOMER_AUTH_TOKEN'),
    CONSULTATION_AUTH_TOKEN: required('CONSULTATION_AUTH_TOKEN'),
    AWS_REGION:
      typeof raw.AWS_REGION === 'string' && raw.AWS_REGION
        ? raw.AWS_REGION
        : 'ap-northeast-2',
    S3_RECORDINGS_BUCKET:
      typeof raw.S3_RECORDINGS_BUCKET === 'string' && raw.S3_RECORDINGS_BUCKET
        ? raw.S3_RECORDINGS_BUCKET
        : undefined,
    RECORDING_ALLOWED_HOSTS: String(
      (raw.RECORDING_ALLOWED_HOSTS ||
        'dvercorp-aicc-connect-dev-recordings.s3.ap-northeast-2.amazonaws.com') as string,
    )
      .split(',')
      .map((host) => host.trim().toLowerCase()),
    RECORDING_MATCH_WINDOW_SECONDS: Number(
      raw.RECORDING_MATCH_WINDOW_SECONDS || '30',
    ),
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
  if (!/^[\x21-\x7e]{32,256}$/.test(config.CONSULTATION_AUTH_TOKEN))
    errors.push('CONSULTATION_AUTH_TOKEN');
  if (
    (raw.AWS_REGION && typeof raw.AWS_REGION !== 'string') ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(config.AWS_REGION)
  )
    errors.push('AWS_REGION');
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
  try {
    const url = new URL(config.CUSTOMER_URL);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== config.CUSTOMER_URL
    )
      errors.push('CUSTOMER_URL');
  } catch {
    errors.push('CUSTOMER_URL');
  }
  if (!/^[\x21-\x7e]{32,256}$/.test(config.CUSTOMER_AUTH_TOKEN))
    errors.push('CUSTOMER_AUTH_TOKEN');
  if (errors.length) throw new EnvironmentValidationError(errors);
  return config;
}
