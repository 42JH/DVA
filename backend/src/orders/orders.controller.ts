import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { MvpAiOrderIntake } from '../auth/mvp-ai-access';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { OrderInputDto } from './dto/order-input.dto';
import { OrdersService } from './orders.service';

class OrderValidationResultDto {
  @ApiProperty({ example: true }) valid!: boolean;
}
class OrderValidationResponseDto {
  @ApiProperty({ type: OrderValidationResultDto }) data!: OrderValidationResultDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('validation')
  @HttpCode(200)
  @MvpAiOrderIntake()
  @ApiOperation({
    summary: 'AI 주문 정보 일괄 검증',
    description:
      '주문·고객을 생성하지 않는 검증 API. MVP 서비스 인증은 135번에서 도입합니다. 실제 최종 접수(57번)는 같은 검증 로직을 서버 내부에서 다시 사용하며 별도 사전 검증 호출을 요구하지 않습니다.',
  })
  @ApiOkResponse({ type: OrderValidationResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto })
  validate(@Body() input: OrderInputDto) {
    return this.orders.validate(input);
  }
}
