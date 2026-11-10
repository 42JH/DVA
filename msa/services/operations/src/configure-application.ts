import { ForbiddenException, INestApplication, Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Environment } from './config/environment';
import { ApiExceptionFilter } from './common/http/api-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { API_PREFIX, requestContext } from './common/http/request-context';
import { createValidationPipe } from './common/http/validation.pipe';
import { ErrorResponseDto, RequestMetaDto } from './common/dto/api-response.dto';
import { json } from 'express';
import type { NextFunction, Request, Response } from 'express';

export function configureApplication(app: INestApplication, logger = new Logger('Http')): void {
  const config = app.get<ConfigService<Environment, true>>(ConfigService);
  app.use(
    requestContext(logger, {
      key: config.get('SECURITY_LOG_HMAC_KEY', { infer: true }),
      proxyHops: config.get('AUTH_PROXY_HOPS', { infer: true }),
    }),
  );
  // Derived question snapshots can exceed the public body limit; retain the shared event transport bound.
  const eventParser = json({ limit: '1mb' });
  app.use('/internal/events', (request: Request, response: Response, next: NextFunction) => {
    eventParser(request, response, next);
  });
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
      { path: 'health', method: RequestMethod.ALL },
      { path: 'health/ready', method: RequestMethod.ALL },
      { path: 'operations/health', method: RequestMethod.ALL },
      { path: 'operations/health/ready', method: RequestMethod.ALL },
      { path: 'internal/auth/session', method: RequestMethod.ALL },
      { path: 'internal/events', method: RequestMethod.ALL },
      { path: 'internal/events/faq-conversion', method: RequestMethod.ALL },
      { path: 'internal/persona-version', method: RequestMethod.ALL },
      { path: 'internal/call-read-references', method: RequestMethod.ALL },
      { path: 'internal/call-read-references/faqs', method: RequestMethod.ALL },
      { path: 'internal/call-read-references/persona-comparison', method: RequestMethod.ALL },
      { path: 'internal/call-read-references/complaint-faqs', method: RequestMethod.ALL },
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
        .setTitle('DVA Operations API')
        .setDescription('모놀리식과 동일한 인증·관리자·감사 API')
        .setVersion('0.1.0')
        .addBearerAuth()
        .addCookieAuth('dva_session', { type: 'apiKey', in: 'cookie' }, 'adminSession')
        .build(),
      { extraModels: [RequestMetaDto, ErrorResponseDto] },
    );
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, {
      jsonDocumentUrl: `${API_PREFIX}/docs-json`,
    });
    SwaggerModule.setup('operations/docs', app, document, {
      jsonDocumentUrl: 'operations/docs-json',
    });
  }
}
