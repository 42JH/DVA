import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { configureApplication } from './configure-application';
import { Environment, EnvironmentValidationError } from './config/environment';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { abortOnError: false });
  configureApplication(app);
  const port = app
    .get<ConfigService<Environment, true>>(ConfigService)
    .get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
}

void bootstrap().catch((error: unknown) => {
  console.error(
    error instanceof EnvironmentValidationError
      ? error.message
      : 'Backend startup failed. Check database connectivity and migration permissions.',
  );
  process.exit(1);
});
