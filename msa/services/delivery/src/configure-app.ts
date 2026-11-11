import { json, type Request, type Response, type NextFunction } from 'express';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureApp(app: INestApplication) {
  // The internal envelope adds fields to the unchanged 100KiB public body.
  const scopeParser = json({ limit: '256kb' });
  // Nest detects parsers by function name; keep its default public JSON parser.
  app.use(
    '/internal/order-shipment-check',
    (request: Request, response: Response, next: NextFunction) => {
      scopeParser(request, response, next);
    },
  );
  app.setGlobalPrefix('delivery', {
    exclude: [
      { path: 'internal/order-shipment-check', method: RequestMethod.ALL },
      { path: 'internal/order-accepted', method: RequestMethod.ALL },
    ],
  });
  const config = new DocumentBuilder()
    .setTitle('DVA Delivery API')
    .setDescription('배송 소유 서비스와 인증된 내부 주문 배송 조회')
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
