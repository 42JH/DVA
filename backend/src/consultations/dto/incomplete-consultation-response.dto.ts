import { ApiProperty } from '@nestjs/swagger';
import { ErrorDetailDto, RequestMetaDto } from '../../common/dto/api-response.dto';
import { OrderInputDto } from '../../orders/dto/order-input.dto';

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

class CollectionAnalysisDto {
  @ApiProperty({ type: [String] }) collectedFields!: string[];
  @ApiProperty({ type: [String] }) missingFields!: string[];
  @ApiProperty({ type: [ErrorDetailDto] }) errors!: ErrorDetailDto[];
}
class ConsultationHistorySummaryDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) startedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) endedAt!: string | null;
  @ApiProperty() utteranceCount!: number;
  @ApiProperty() recordingCount!: number;
}
class IncompleteConsultationDetailDto extends IncompleteConsultationSummaryDto {
  @ApiProperty() eventId!: string;
  @ApiProperty({ type: OrderInputDto }) snapshot!: OrderInputDto;
  @ApiProperty({ type: CollectionAnalysisDto }) collectionAnalysis!: CollectionAnalysisDto;
  @ApiProperty({ type: ConsultationHistorySummaryDto }) history!: ConsultationHistorySummaryDto;
}
export class IncompleteConsultationDetailResponseDto {
  @ApiProperty({ type: IncompleteConsultationDetailDto }) data!: IncompleteConsultationDetailDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
