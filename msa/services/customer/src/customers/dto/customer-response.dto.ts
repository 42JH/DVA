import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { CUSTOMER_STATUSES, type CustomerStatus } from '../customers.types';

import { CustomerAddressDto } from './customer-address.dto';

export class CreatedCustomerDto {
  @ApiProperty({ type: Number, minimum: 1 })
  customerSeq!: number;
}
export class CustomerResponseDto extends CreatedCustomerDto {
  @ApiProperty({
    type: CustomerAddressDto,
    nullable: true,
    description: 'PIN과 독립된 고객의 내 주소. 미등록 시 null.',
  })
  address!: CustomerAddressDto | null;
  @ApiProperty({ description: '개인 월결제 사용 자격.' }) monthlyBillingEnabled!: boolean;
  @ApiProperty()
  name!: string;
  @ApiProperty()
  phoneNumber!: string;
  @ApiProperty({ enum: CUSTOMER_STATUSES })
  status!: CustomerStatus;
}
export class CreatedCustomerEnvelopeDto {
  @ApiProperty({ type: CreatedCustomerDto })
  data!: CreatedCustomerDto;
  @ApiProperty({ type: RequestMetaDto })
  meta!: RequestMetaDto;
}
export class CustomerEnvelopeDto {
  @ApiProperty({ type: CustomerResponseDto })
  data!: CustomerResponseDto;
  @ApiProperty({ type: RequestMetaDto })
  meta!: RequestMetaDto;
}
export class CustomersEnvelopeDto {
  @ApiProperty({ type: [CustomerResponseDto] })
  data!: CustomerResponseDto[];
  @ApiProperty()
  hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
