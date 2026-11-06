import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ParcelInputDto } from './create-order.dto';
import {
  DRAFT_CLEAR_FIELDS,
  DraftClearField,
  PARCEL_DRAFT_STATUSES,
  ParcelDraftStatus,
} from '../parcel-drafts.types';

const integer = ({ value }: TransformFnParams) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
const present = (_: unknown, value: unknown) => value !== undefined;

export class DraftIdParamsDto {
  @ApiProperty({
    minimum: 1,
    maximum: 2147483647,
    description: '초안 번호. orderSeq·orderParcelSeq와 다릅니다.',
  })
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}

export class CreateParcelDraftDto {
  @ApiProperty({
    format: 'uuid',
    description: '통화 내 배송 단건의 고정 UUID. 같은 생성 재시도에 재사용.',
  })
  @IsUUID()
  clientParcelId!: string;

  @ApiProperty({
    enum: ['READY', 'EDITING'],
    description: 'READY는 주소·물품·가액·배송비 필수 검증. EDITING은 수집 중.',
  })
  @IsIn(['READY', 'EDITING'])
  status!: 'READY' | 'EDITING';

  @ApiPropertyOptional({
    type: () => ParcelInputDto,
    description: '배송 단건. 신규 생성 필수, 재개는 원본을 복사하고 전달 필드만 덮어씀.',
  })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => ParcelInputDto)
  parcel?: ParcelInputDto;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: '재개할 INCOMPLETE 초안. 같은 고객만 사용 가능.',
  })
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  sourceDraftSeq?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: '관리자 단독 초안은 필수. AI는 통화 고객과 같아야 함.',
  })
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  customerSeq?: number;
}

export class PatchParcelDraftDto {
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedVersion!: number;

  @ApiProperty({ enum: ['START_EDIT', 'SAVE', 'CANCEL'] })
  @IsIn(['START_EDIT', 'SAVE', 'CANCEL'])
  action!: 'START_EDIT' | 'SAVE' | 'CANCEL';

  @ApiPropertyOptional({
    enum: DRAFT_CLEAR_FIELDS,
    isArray: true,
    description: 'START_EDIT 필수. 해당 값을 비우며 주소·물품·가액 변경은 배송비도 비움.',
  })
  @ValidateIf(present)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(DRAFT_CLEAR_FIELDS, { each: true })
  clearFields?: DraftClearField[];

  @ApiPropertyOptional({
    enum: ['READY', 'EDITING'],
    description: 'SAVE 필수. READY로 돌아갈 때 전체 내용을 검증.',
  })
  @ValidateIf(present)
  @IsIn(['READY', 'EDITING'])
  status?: 'READY' | 'EDITING';

  @ApiPropertyOptional({
    type: () => ParcelInputDto,
    description: 'SAVE에서 변경한 필드만 입력. 생략 유지, 허용된 null은 비우기.',
  })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => ParcelInputDto)
  parcel?: ParcelInputDto;
}

export class ParcelDraftQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: [...PARCEL_DRAFT_STATUSES, 'ALL'], default: 'INCOMPLETE' })
  @IsIn([...PARCEL_DRAFT_STATUSES, 'ALL'])
  status: ParcelDraftStatus | 'ALL' = 'INCOMPLETE';

  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  customerSeq?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 2147483647 })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  callSessionSeq?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: '이관 원본 주문 번호로 초안을 찾습니다.',
  })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  legacyOrderSeq?: number;

  @ApiPropertyOptional({ description: '발송·수령 이름/전화/주소 부분 검색.', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ParcelDraftResponseDto {
  @ApiProperty() draftSeq!: number;
  @ApiProperty({ nullable: true }) callSessionSeq!: number | null;
  @ApiProperty({ nullable: true }) customerSeq!: number | null;
  @ApiProperty({ nullable: true }) createdByAdminUserSeq!: number | null;
  @ApiProperty({ format: 'uuid' }) clientParcelId!: string;
  @ApiProperty({ type: () => ParcelInputDto }) parcel!: ParcelInputDto;
  @ApiProperty({ enum: PARCEL_DRAFT_STATUSES }) status!: ParcelDraftStatus;
  @ApiProperty() version!: number;
  @ApiPropertyOptional({
    nullable: true,
    description: '변경 응답의 최신 통화 초안 집합 버전. 관리자 단독 초안은 null.',
  })
  intakeVersion?: number | null;
  @ApiProperty({ nullable: true }) sourceDraftSeq!: number | null;
  @ApiProperty({ nullable: true }) orderSeq!: number | null;
  @ApiProperty({ nullable: true }) orderParcelSeq!: number | null;
  @ApiProperty({ nullable: true }) legacyOrderSeq!: number | null;
  @ApiProperty({ nullable: true }) legacyOrderParcelSeq!: number | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
  @ApiProperty({ format: 'date-time' }) retentionStartedAt!: Date;
}
