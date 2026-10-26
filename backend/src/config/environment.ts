export interface Environment {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  AI_AGENT_URL: string;
  CORS_ORIGINS: string[];
  SWAGGER_ENABLED: boolean;
  PBX_WEBHOOK_TOKEN?: string;
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
  if (
    token !== undefined &&
    token !== '' &&
    (typeof token !== 'string' || Buffer.byteLength(token) < 32 || /\s/.test(token))
  ) {
    errors.push('PBX_WEBHOOK_TOKEN');
  }
  const config: Environment = {
    NODE_ENV: nodeEnv as Environment['NODE_ENV'],
    PORT: port('PORT', 3000),
    DB_HOST: required('DB_HOST'),
    DB_PORT: port('DB_PORT', 5432),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    AI_AGENT_URL: aiUrl.replace(/\/$/, ''),
    CORS_ORIGINS: [...new Set(origins)],
    SWAGGER_ENABLED: swagger === 'true',
    PBX_WEBHOOK_TOKEN: typeof token === 'string' && token ? token : undefined,
  };
  if (errors.length) throw new EnvironmentValidationError(errors);
  return config;
}
