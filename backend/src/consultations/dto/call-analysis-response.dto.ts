import { ApiProperty } from '@nestjs/swagger';
import { CallComplaintDto } from '../../call-insights/dto/create-call-analysis.dto';

export class CallAnalysisDto {
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

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'AI 판정 신규 true / 기존 false. 미수집은 null.',
  })
  isNewCustomer!: boolean | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI 집계 접수 확정 배송 상세 수. 결제 대기 포함. 미수집은 null.',
  })
  registeredParcelCount!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI 집계 FAQ 답변 건수. 미수집은 null.',
  })
  faqAnswerCount!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI 집계 접수 내역 조회·안내 건수. 미수집은 null.',
  })
  orderLookupCount!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI 집계 취소 완료 배송 상세 수. 미수집은 null.',
  })
  cancelledParcelCount!: number | null;

  @ApiProperty({
    type: Boolean,
    nullable: true,
    description: 'AI 판정 상담원 연결 요구 여부. 연결 성공과 별개. 미수집은 null.',
  })
  hasHandoffRequest!: boolean | null;

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
