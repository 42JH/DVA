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
