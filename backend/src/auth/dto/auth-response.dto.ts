import { ApiProperty } from '@nestjs/swagger';
import { ADMIN_ROLES, ADMIN_STATUSES, AdminRole, AdminStatus } from '../../admins/admins.types';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
export class AdminMeDto {
  @ApiProperty() adminUserSeq!: number;
  @ApiProperty() loginId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ADMIN_ROLES }) role!: AdminRole;
  @ApiProperty({ enum: ADMIN_STATUSES }) status!: AdminStatus;
}
export class AdminResponseDto extends AdminMeDto {
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastLoginAt!: Date | null;
}
export class LoginResultDto {
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
}
export class LoginEnvelopeDto {
  @ApiProperty({ type: LoginResultDto }) data!: LoginResultDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class MeEnvelopeDto {
  @ApiProperty({ type: AdminMeDto }) data!: AdminMeDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AdminListDto {
  @ApiProperty({ type: [AdminResponseDto] }) data!: AdminResponseDto[];
  @ApiProperty() hasNext!: boolean;
}
