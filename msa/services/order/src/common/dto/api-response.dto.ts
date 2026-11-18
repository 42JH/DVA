import { ApiProperty } from '@nestjs/swagger';

export class RequestMetaDto {
  @ApiProperty({ format: 'uuid' })
  requestId!: string;
}

export class ErrorDetailDto {
  @ApiProperty()
  field!: string;

  @ApiProperty()
  reason!: string;
}

export class ApiErrorDto {
  @ApiProperty({ example: 'INVALID_REQUEST' })
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ type: [ErrorDetailDto] })
  details!: ErrorDetailDto[];
}

export class ErrorResponseDto {
  @ApiProperty({ type: ApiErrorDto })
  error!: ApiErrorDto;

  @ApiProperty({ type: RequestMetaDto })
  meta!: RequestMetaDto;
}
