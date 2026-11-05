import {
  ForbiddenException,
  INestApplication,
  Logger,
  RequestMethod,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  ErrorResponseDto,
  RequestMetaDto,
} from './common/dto/api-response.dto';
import { ApiExceptionFilter } from './common/http/api-exception.filter';
import { API_PREFIX, requestContext } from './common/http/request-context';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { createValidationPipe } from './common/http/validation.pipe';
import { type Environment } from './config/environment';
import type { NextFunction, Request, Response } from 'express';

export function configureApplication(
  app: INestApplication,
  logger = new Logger('Http'),
): void {
  const config = app.get<ConfigService<Environment, true>>(ConfigService);
  // Preserve the monolith Nginx PBX prefix rewrite on direct MSA ingress traffic.
  app.use((request: Request, _response: Response, next: NextFunction) => {
    if (request.path.replace(/\/$/, '') === '/api/webhooks/pbx/call-ended')
      request.url = request.url.slice(4);
    next();
  });
  app.use(requestContext(logger));
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (
        !origin ||
        config.get('CORS_ORIGINS', { infer: true }).includes(origin)
      )
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
      { path: 'internal/caller-context', method: RequestMethod.ALL },
      { path: 'internal/audit/flush', method: RequestMethod.ALL },
      { path: 'consultation/health', method: RequestMethod.ALL },
      { path: 'consultation/health/ready', method: RequestMethod.ALL },
      { path: 'webhooks/pbx/call-ended', method: RequestMethod.ALL },
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
        .setTitle('DVA Consultation API')
        .setDescription(
          '모놀리식과 동일한 PBX 수신·녹취 처리와 진행 통화 수 API',
        )
        .setVersion('0.1.0')
        .addBearerAuth()
        .addCookieAuth(
          'dva_session',
          { type: 'apiKey', in: 'cookie' },
          'adminSession',
        )
        .build(),
      { extraModels: [RequestMetaDto, ErrorResponseDto] },
    );
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, {
      jsonDocumentUrl: `${API_PREFIX}/docs-json`,
    });
    SwaggerModule.setup('consultation/docs', app, document, {
      jsonDocumentUrl: 'consultation/docs-json',
    });
  }
}
