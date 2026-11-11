import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { RequestMetaDto } from '../common/dto/api-response.dto';

export class RegisterPaymentCardDto {
  @ApiProperty({ description: '등록 시 PG에 한 번 전달하는 카드번호.' })
  @IsString()
  @Matches(/^[0-9]{14,20}$/)
  cardNumber!: string;

  @ApiProperty({ example: 2028 })
  @IsInt()
  @Min(2000)
  @Max(2099)
  expirationYear!: number;

  @ApiProperty({ minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  expirationMonth!: number;

  @ApiProperty({ description: '생년월일 6자리 또는 사업자등록번호 10자리. 저장하지 않습니다.' })
  @IsString()
  @Matches(/^(?:[0-9]{6}|[0-9]{10})$/)
  customerIdentityNumber!: string;

  @ApiPropertyOptional({
    description: 'PG 계약에서 요구하는 카드 비밀번호 앞 두 자리. 저장하지 않습니다.',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(/^[0-9]{2}$/)
  cardPassword?: string;

  @ApiPropertyOptional()
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @MaxLength(100)
  customerName?: string;
}

export class PaymentCardDto {
  @ApiProperty() paymentCardSeq!: number;
  @ApiProperty({ nullable: true }) issuerCode!: string | null;
  @ApiProperty({ nullable: true }) maskedNumber!: string | null;
  @ApiProperty() expirationYear!: number;
  @ApiProperty() expirationMonth!: number;
  @ApiProperty() active!: boolean;
}

export class PaymentCardEnvelopeDto {
  @ApiProperty({ type: PaymentCardDto, nullable: true }) data!: PaymentCardDto | null;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
