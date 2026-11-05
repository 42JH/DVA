import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { configureApplication } from './configure-application';
import { type Environment, EnvironmentValidationError } from './config/environment';
import { JsonLogger } from './observability/json-logger';

const logger = new JsonLogger();

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { abortOnError: false, logger });
  configureApplication(app);
  const port = app
    .get<ConfigService<Environment, true>>(ConfigService)
    .get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  logger.log({ event: 'backend_started' });
}

void bootstrap().catch((error: unknown) => {
  logger.error({
    event: 'backend_startup_failed',
    invalidFields: error instanceof EnvironmentValidationError ? error.fields : undefined,
  });
  process.exit(1);
});
