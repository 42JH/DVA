import { ApiProperty } from '@nestjs/swagger';
import { ADMIN_ROLES, ADMIN_STATUSES, AdminRole, AdminStatus } from '../../admins/admins.types';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
export class AdminMeDto {
  @ApiProperty({ description: '관리자 번호.' }) adminUserSeq!: number;
  @ApiProperty({ description: '로그인 ID.', example: 'operator01' }) loginId!: string;
  @ApiProperty({ description: '관리자 이름.', example: '홍길동' }) name!: string;
  @ApiProperty({ description: '관리자 권한.', enum: ADMIN_ROLES }) role!: AdminRole;
  @ApiProperty({ description: 'PENDING: 승인 대기, ACTIVE: 사용 가능.', enum: ADMIN_STATUSES })
  status!: AdminStatus;
}
export class AdminResponseDto extends AdminMeDto {
  @ApiProperty({ description: '가입 신청 시각.', type: String, format: 'date-time' })
  createdAt!: Date;
  @ApiProperty({
    description: '마지막 로그인 시각. 로그인 이력이 없으면 null.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  lastLoginAt!: Date | null;
}
export class LoginResultDto {
  @ApiProperty({
    description: '세션 만료 시각. 로그인 시점부터 9시간이며 자동 연장되지 않습니다.',
    type: String,
    format: 'date-time',
  })
  expiresAt!: Date;
}
export class LoginEnvelopeDto {
  @ApiProperty({ description: '로그인 결과.', type: LoginResultDto }) data!: LoginResultDto;
  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class MeEnvelopeDto {
  @ApiProperty({ description: '현재 관리자 정보.', type: AdminMeDto }) data!: AdminMeDto;
  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AdminListDto {
  @ApiProperty({ description: '관리자 목록.', type: [AdminResponseDto] }) data!: AdminResponseDto[];
  @ApiProperty({ description: '다음 페이지 존재 여부.' }) hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
