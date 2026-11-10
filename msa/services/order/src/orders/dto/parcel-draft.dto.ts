import { ApiProperty, ApiPropertyOptional, OmitType, PickType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { OrderQueryDto } from './order-query.dto';
import { OrderParcelDto } from './order-response.dto';
import { PARCEL_DRAFT_STATUSES, type ParcelDraftStatus } from '../parcel-drafts.types';
const integer = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

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

export class ParcelDraftQueryDto extends PickType(OrderQueryDto, [
  'from',
  'to',
  'limit',
  'offset',
] as const) {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: '연결 고객의 현재 소속 기업 번호. 삭제된 연결은 제외합니다.',
  })
  @IsOptional()
  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  organizationSeq?: number;

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

  @ApiPropertyOptional({
    description: '발송·수령 이름/전화/주소 부분 검색. 전화번호는 하이픈 허용.',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class DraftParcelSnapshotDto extends OmitType(OrderParcelDto, [
  'orderSeq',
  'orderParcelSeq',
  'parcelPosition',
  'status',
] as const) {}

export class ParcelDraftResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: '생성 당시 발신번호 사본. 원본 통화 삭제와 독립적으로 보존.',
  })
  callerPhoneNumber!: string | null;
  @ApiProperty() draftSeq!: number;
  @ApiProperty({
    type: Number,
    minimum: 1,
    description:
      'DV 표시용 예약 주문번호. 실제 주문 생성 전에도 존재하며 draftSeq로 초안을 조회합니다.',
  })
  reservedOrderSeq!: number;
  @ApiProperty({ type: Number, nullable: true }) callSessionSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) customerSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) createdByAdminUserSeq!: number | null;
  @ApiProperty({ format: 'uuid' }) clientParcelId!: string;
  @ApiProperty({ type: () => DraftParcelSnapshotDto }) parcel!: DraftParcelSnapshotDto;
  @ApiProperty({ enum: PARCEL_DRAFT_STATUSES }) status!: ParcelDraftStatus;
  @ApiProperty() version!: number;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: '변경 응답의 최신 통화 초안 집합 버전. 관리자 단독 초안은 null.',
  })
  intakeVersion?: number | null;
  @ApiProperty({ type: Number, nullable: true }) sourceDraftSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) orderSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) orderParcelSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) legacyOrderSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) legacyOrderParcelSeq!: number | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
  @ApiProperty({ format: 'date-time' }) retentionStartedAt!: Date;
}
