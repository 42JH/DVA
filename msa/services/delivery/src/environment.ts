export interface Environment {
  PORT: number;
  DB_HOST: string;
  DB_PORT: number;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_NAME: string;
  CUSTOMER_AUTH_TOKEN: string;
}
export function validateEnvironment(raw: Record<string, unknown>): Environment {
  const errors: string[] = [];
  const required = (key: string) => {
    if (typeof raw[key] !== 'string' || !raw[key].trim()) errors.push(key);
    return raw[key] as string;
  };
  const port = (key: string, fallback: number) => {
    const value = raw[key] ?? String(fallback);
    if (
      typeof value !== 'string' ||
      !/^[0-9]+$/.test(value) ||
      Number(value) < 1 ||
      Number(value) > 65535
    )
      errors.push(key);
    return Number(value);
  };
  const config = {
    PORT: port('PORT', 3003),
    DB_PORT: port('DB_PORT', 5432),
    DB_HOST: required('DB_HOST'),
    DB_USER: required('DB_USER'),
    DB_PASSWORD: required('DB_PASSWORD'),
    DB_NAME: required('DB_NAME'),
    CUSTOMER_AUTH_TOKEN: required('CUSTOMER_AUTH_TOKEN'),
  };
  if (!/^[\x21-\x7e]{32,256}$/.test(config.CUSTOMER_AUTH_TOKEN))
    errors.push('CUSTOMER_AUTH_TOKEN');
  if (errors.length)
    throw new Error(
      'Invalid environment variables: ' + [...new Set(errors)].join(', '),
    );
  return config;
}
