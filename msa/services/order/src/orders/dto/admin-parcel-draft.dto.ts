import { ApiProperty, IntersectionType, PickType } from '@nestjs/swagger';
import { CreateOrderDto } from './create-order.dto';
import { SubmitOrderDto } from './submit-order.dto';
import { OrderResultDto } from './order-response.dto';

export class SubmitAdminParcelDraftDto extends IntersectionType(
  SubmitOrderDto,
  PickType(CreateOrderDto, ['paymentMethodType', 'pickupRequestedAt'] as const),
) {}

export class AdminParcelDraftResultDto extends OrderResultDto {
  @ApiProperty() draftSeq!: number;
  @ApiProperty() orderParcelSeq!: number;
}
