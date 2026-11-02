import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const present = (_object: unknown, value: unknown) => value !== undefined;
const nonNull = (_object: unknown, value: unknown) => value !== undefined && value !== null;
const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.normalize('NFC').trim() : value;

export class PinAddressInputDto {
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() name!: string;
  @ApiProperty({ pattern: '^[0-9]+(?![\\s\\S])', example: '01012345678' })
  @IsString()
  @Matches(/^[0-9]+(?![\s\S])/)
  phoneNumber!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() roadAddress!: string;
  @ApiProperty() @Transform(trim) @IsString() @IsNotEmpty() jibunAddress!: string;
  @ApiPropertyOptional({ description: '생략 또는 빈 문자열 허용. null 불가.' })
  @ValidateIf(present)
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

export class CreatePinDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: '별칭. null로 제거.' })
  @ValidateIf(nonNull)
  @Transform(trim)
  @IsString()
  label?: string | null;
  @ApiProperty({ type: PinAddressInputDto, description: '고객 확인이 끝난 완성 주소.' })
  @IsObject()
  @ValidateNested()
  @Type(() => PinAddressInputDto)
  addressData!: PinAddressInputDto;
}

export class UpdatePinDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '생략하면 유지, null이면 제거.',
  })
  @ValidateIf(nonNull)
  @Transform(trim)
  @IsString()
  label?: string | null;
  @ApiPropertyOptional({
    type: PinAddressInputDto,
    description: '전달할 때 완성 주소 전체 교체. 생략하면 유지.',
  })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => PinAddressInputDto)
  addressData?: PinAddressInputDto;
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    deprecated: true,
    description: '호환용 선택값. 수정 조건으로 사용하지 않으며 오래된 버전도 반영합니다.',
  })
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedVersion?: number;
}

export class PinIdParamsDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647 })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^[0-9]+(?![\s\S])/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}

export class ListPinsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '개인 PIN의 별칭·수령인·전화번호·주소 부분 검색.',
  })
  @ValidateIf(present)
  @Transform(trim)
  @IsString()
  q?: string;
}
