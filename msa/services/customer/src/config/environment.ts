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
  CUSTOMER_AUTH_TOKEN: string;
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
  const config: Environment = {
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    PORT: port('PORT', 3001),
    DB_HOST: required('DB_HOST'),
    DB_PORT: port('DB_PORT', 5432),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    CORS_ORIGINS: origins,
    SWAGGER_ENABLED: swagger === 'true',
    OPERATIONS_URL: required('OPERATIONS_URL'),
    CUSTOMER_AUTH_TOKEN: required('CUSTOMER_AUTH_TOKEN'),
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
  if (errors.length) throw new EnvironmentValidationError(errors);
  return config;
}
