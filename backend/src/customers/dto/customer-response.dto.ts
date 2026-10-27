import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { CUSTOMER_STATUSES, CustomerStatus } from '../customers.types';

export class CreatedCustomerDto {
  @ApiProperty({ type: Number, minimum: 1 })
  customerSeq!: number;
}
export class CustomerResponseDto extends CreatedCustomerDto {
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
}
