import { json, type Request, type Response, type NextFunction } from 'express';
import { ForbiddenException, INestApplication, Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponseDto, RequestMetaDto } from './common/dto/api-response.dto';
import { ApiExceptionFilter } from './common/http/api-exception.filter';
import { API_PREFIX, requestContext } from './common/http/request-context';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { createValidationPipe } from './common/http/validation.pipe';
import { type Environment } from './config/environment';

export function configureApp(app: INestApplication, logger = new Logger('Http')): void {
  const config = app.get<ConfigService<Environment, true>>(ConfigService);
  app.use(
    requestContext(logger, {
      key: config.get('SECURITY_LOG_HMAC_KEY', { infer: true }),
      proxyHops: config.get('AUTH_PROXY_HOPS', { infer: true }),
    }),
  );
  // The internal envelope adds fields to the unchanged 100KiB public body.
  const scopeParser = json({ limit: '256kb' });
  // Nest detects parsers by function name; keep its default public JSON parser.
  app.use(
    '/internal/order-cancellation',
    (request: Request, response: Response, next: NextFunction) => {
      scopeParser(request, response, next);
    },
  );
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || config.get('CORS_ORIGINS', { infer: true }).includes(origin))
        callback(null, true);
      else callback(new ForbiddenException('Origin not allowed'));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Accept',
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'call_session_seq',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id', 'Location', 'Retry-After'],
    credentials: true,
  });
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'order/health', method: RequestMethod.ALL },
      { path: 'order/health/ready', method: RequestMethod.ALL },
      { path: 'internal/billing/read', method: RequestMethod.ALL },
      { path: 'internal/billing/initialize', method: RequestMethod.ALL },
      { path: 'internal/audit/flush', method: RequestMethod.ALL },
      { path: 'internal/call-draft-deletion-check', method: RequestMethod.ALL },
      { path: 'internal/order-read', method: RequestMethod.ALL },
      { path: 'internal/call-event-order-scope', method: RequestMethod.ALL },
      { path: 'internal/call-read-references', method: RequestMethod.ALL },
      { path: 'internal/order-cancellation', method: RequestMethod.ALL },
    ],
  });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('DVA Order API')
        .setDescription('모놀리식과 동일한 주문 조회·삭제·취소 및 이전 주문 주소 API')
        .setVersion('0.1.0')
        .addBearerAuth()
        .addCookieAuth('dva_session', { type: 'apiKey', in: 'cookie' }, 'adminSession')
        .build(),
      { extraModels: [RequestMetaDto, ErrorResponseDto] },
    );
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, {
      jsonDocumentUrl: `${API_PREFIX}/docs-json`,
    });
    SwaggerModule.setup('order/docs', app, document, {
      jsonDocumentUrl: 'order/docs-json',
    });
  }
}
