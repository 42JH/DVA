import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';

export class IncompleteConsultationSavedDto {
  @ApiProperty() incompleteConsultationSeq!: number;
  @ApiProperty() callSessionSeq!: number;
}
export class IncompleteConsultationSavedResponseDto {
  @ApiProperty({ type: IncompleteConsultationSavedDto }) data!: IncompleteConsultationSavedDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}

export class IncompleteConsultationSummaryDto extends IncompleteConsultationSavedDto {
  @ApiProperty() providerCallId!: string;
  @ApiProperty({ format: 'date-time' }) endedAt!: string;
  @ApiProperty({ type: String, nullable: true }) endType!: string | null;
  @ApiProperty({ type: String, nullable: true }) systemEvent!: string | null;
  @ApiProperty({ type: [String] }) missingFields!: string[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class IncompleteConsultationListDto {
  @ApiProperty({ type: [IncompleteConsultationSummaryDto] })
  data!: IncompleteConsultationSummaryDto[];
  @ApiProperty() hasNext!: boolean;
}
