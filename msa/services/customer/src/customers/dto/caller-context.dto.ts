import { ApiProperty } from '@nestjs/swagger';

export class PinAddressDto {
  @ApiProperty() name!: string;
  @ApiProperty() phoneNumber!: string;
  @ApiProperty() roadAddress!: string;
  @ApiProperty() jibunAddress!: string;
  @ApiProperty({ type: String, nullable: true, required: false }) detailAddress?: string | null;
  @ApiProperty() dongName!: string;
  @ApiProperty() postalCode!: string;
}
