import { ApiProperty } from '@nestjs/swagger';
import { CALL_ANALYSIS_RESULTS, CallAnalysisResult } from '../../call-insights/call-insights.types';
import { CallComplaintDto } from '../../call-insights/dto/create-call-analysis.dto';

export class CallAnalysisDto {
  @ApiProperty({ enum: CALL_ANALYSIS_RESULTS, description: 'AI가 확정한 당시 통화 결과.' })
  result!: CallAnalysisResult;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '실제 사용한 페르소나 버전의 DB 번호.',
  })
  aiPersonaVersionSeq!: number | null;

  @ApiProperty({ type: String, nullable: true, description: '실제 사용한 버전의 페르소나 이름.' })
  personaName!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: '실제 사용한 버전 숫자. 예: 6은 v6.' })
  personaVersion!: number | null;

  @ApiProperty({ format: 'date-time', description: 'AI가 측정한 통화 시작. PBX 시각과 별개.' })
  aiStartedAt!: Date;

  @ApiProperty({ format: 'date-time', description: 'AI가 측정한 통화 종료. PBX 시각과 별개.' })
  aiEndedAt!: Date;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    description: '되묻기 횟수. 미측정은 null.',
  })
  repeatQuestionCount!: number | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: '불만 판정. 미판정은 null, 확인된 없음은 false.',
  })
  hasComplaint!: boolean | null;

  @ApiProperty({
    type: [CallComplaintDto],
    maxItems: 20,
    description: '저장된 불만 근거·정수 초 위치·같은 통화의 발화 순번.',
  })
  complaints!: CallComplaintDto[];

  @ApiProperty({
    format: 'date-time',
    description: '백엔드에 분석을 저장한 시각. 통화 종료 시각과 별개.',
  })
  analysedAt!: Date;
}
