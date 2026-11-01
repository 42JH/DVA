import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsNumber, Max, Min } from 'class-validator';
import { CustomerAddressDto } from '../../customers/dto/customer-address.dto';

const coordinate = ({ value }: TransformFnParams): unknown => value ?? 1;

// shortcut: 사원 등록에서 누락된 좌표는 1로 저장한다. 실제 위치를 사용하는 연동 전에 대체한다.
export class MemberAddressDto extends OmitType(CustomerAddressDto, [
  'latitude',
  'longitude',
] as const) {
  @ApiPropertyOptional({
    type: Number,
    minimum: -90,
    maximum: 90,
    default: 1,
    nullable: true,
    description: '미전달 또는 null이면 1. 전달한 숫자는 0을 포함해 유지합니다.',
  })
  @Transform(coordinate)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude = 1;

  @ApiPropertyOptional({
    type: Number,
    minimum: -180,
    maximum: 180,
    default: 1,
    nullable: true,
    description: '미전달 또는 null이면 1. 전달한 숫자는 0을 포함해 유지합니다.',
  })
  @Transform(coordinate)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude = 1;
}
