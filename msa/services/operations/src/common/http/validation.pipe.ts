import { ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { ApiException, ErrorDetail } from '../errors/api.exception';

function details(errors: ValidationError[], prefix = ''): ErrorDetail[] {
  return errors.flatMap((error) => {
    const field = prefix ? `${prefix}.${error.property}` : error.property;
    return [
      ...Object.keys(error.constraints ?? {}).map((reason) => ({ field, reason })),
      ...details(error.children ?? [], field),
    ];
  });
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) =>
      new ApiException(400, 'INVALID_REQUEST', '요청 형식을 확인해 주세요.', details(errors)),
  });
}
