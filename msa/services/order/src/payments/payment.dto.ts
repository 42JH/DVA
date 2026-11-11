import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { ORDER_STATUSES } from '../orders/orders.types';
const uuidCase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;
export class PaymentIdDto {
  @ApiProperty({ format: 'uuid' }) @Transform(uuidCase) @IsUUID('4') id!: string;
}
export class ConfirmPaymentDto {
  @ApiProperty({ format: 'uuid' }) @Transform(uuidCase) @IsUUID('4') orderId!: string;
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  amount!: number;
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Matches(/^[\x21-\x7e]+$/)
  paymentKey!: string;
}
export class EmptyPaymentDto {}
export class PaymentStatusDto {
  @ApiProperty({ format: 'uuid' }) token!: string;
  @ApiProperty() orderName!: string;
  @ApiProperty({ type: String, nullable: true }) senderName!: string | null;
  @ApiProperty({ type: String, nullable: true }) recipientSummary!: string | null;
  @ApiProperty() parcelCount!: number;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty() orderSeq!: number;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() amount!: number;
  @ApiProperty({ enum: ['PENDING', 'REVIEW_REQUIRED', 'PAID', 'EXPIRED', 'CANCELLED'] })
  status!: string;
  @ApiProperty({ enum: ORDER_STATUSES }) orderStatus!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) approvedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) pickupRequestedAt!:
    string | null;
  @ApiProperty({ enum: ['PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'] })
  notificationStatus!: string;
  @ApiProperty({
    enum: ['WAITING', 'PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN'],
    description:
      '결제 완료 안내 발송 상태. WAITING은 미결제이며 결제 요청 안내와 별도로 관리합니다.',
  })
  completionNotificationStatus!: string;
}
