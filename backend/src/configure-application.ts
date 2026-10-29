import { ForbiddenException, INestApplication, Logger, RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Environment } from './config/environment';
import { ApiExceptionFilter } from './common/http/api-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor';
import { API_PREFIX, requestContext } from './common/http/request-context';
import { createValidationPipe } from './common/http/validation.pipe';
import { ErrorResponseDto, RequestMetaDto } from './common/dto/api-response.dto';

export function configureApplication(app: INestApplication, logger = new Logger('Http')): void {
  const config = app.get<ConfigService<Environment, true>>(ConfigService);
  app.use(requestContext(logger));
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
      { path: 'internal/metrics', method: RequestMethod.ALL },
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
        .setTitle('Dva Monolith API')
        .setDescription(
          '모놀리식 공통 기반. 신규 업무 API는 /api, 기존 health/PBX는 기존 계약을 유지합니다.',
        )
        .setVersion('0.1.0')
        .addBearerAuth()
        .addCookieAuth('dva_session', { type: 'apiKey', in: 'cookie' }, 'adminSession')
        .build(),
      { extraModels: [RequestMetaDto, ErrorResponseDto] },
    );
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, document, {
      jsonDocumentUrl: `${API_PREFIX}/docs-json`,
    });
  }
}
