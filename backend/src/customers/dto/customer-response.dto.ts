import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { CUSTOMER_STATUSES, CustomerPaymentMethod, CustomerStatus } from '../customers.types';

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
export class CustomerListItemDto extends CustomerResponseDto {
  @ApiProperty({
    enum: ['billing', 'credit', 'groupBilling'],
    isArray: true,
    description:
      '조회 시점의 결제 가능 수단. billing 개인 카드, credit 월결제, groupBilling 부서 그룹결제 순서. 고객 확인 API와 동일한 기준이며 탈퇴 고객은 빈 배열.',
  })
  availablePaymentMethods!: CustomerPaymentMethod[];
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
  @ApiProperty({ type: [CustomerListItemDto] })
  data!: CustomerListItemDto[];
  @ApiProperty()
  hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
