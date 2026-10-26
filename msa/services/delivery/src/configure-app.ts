import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('delivery');
  const config = new DocumentBuilder()
    .setTitle('DVA Delivery API')
    .setDescription('배송 관리 서비스 — 업무 API 구현 전 인프라 구성')
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    () => SwaggerModule.createDocument(app, config),
    {
      useGlobalPrefix: true,
      jsonDocumentUrl: 'docs-json',
    },
  );
  app.enableShutdownHooks();
}
