import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { Environment } from './environment';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(
    app
      .get<ConfigService<Environment, true>>(ConfigService)
      .get('PORT', { infer: true }),
    '0.0.0.0',
  );
}

void bootstrap();
