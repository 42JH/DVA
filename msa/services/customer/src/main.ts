import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('DVA Customer API')
    .setDescription('고객·기업 관리 서비스')
    .setVersion('0.1.0')
    .build();

  const documentFactory = () =>
    SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('docs', app, documentFactory, {
    jsonDocumentUrl: 'docs-json',
  });

  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3001, '0.0.0.0');
}

void bootstrap();