import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';

const trim = ({ value }: TransformFnParams): unknown =>
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
  @ApiProperty({ minimum: -90, maximum: 90 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;
  @ApiProperty({ minimum: -180, maximum: 180 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;
}
