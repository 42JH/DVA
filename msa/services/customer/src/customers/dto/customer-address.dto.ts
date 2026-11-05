import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.normalize('NFC').trim() : value;

export class CustomerAddressDto {
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() roadAddress!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() jibunAddress!: string;
  @ApiPropertyOptional({ description: '생략 또는 빈 문자열 허용. null 불가.' })
  @ValidateIf((_o, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  detailAddress?: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() dongName!: string;
  @ApiProperty({ pattern: '^[0-9]{5}(?![\\s\\S])', example: '01234' })
  @IsString()
  @Matches(/^[0-9]{5}(?![\s\S])/)
  postalCode!: string;
}
