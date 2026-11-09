import { ApiProperty, PickType } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { AdminOrderStatusCountsDto } from '../../orders/dto/admin-order-list.dto';
import { ParcelDraftResponseDto } from '../../orders/dto/parcel-draft.dto';
import { CallListItemDto } from '../../consultations/dto/call-response.dto';
import { UnansweredQuestionDto } from '../../unanswered-questions/dto/unanswered-question-list-response.dto';
import {
  ComplaintCallsDto,
  RegistrationTimeDto,
  ResponseWaitDto,
  StageDropoffsDto,
} from './dashboard-response.dto';

export class HomePendingWorkDto extends PickType(AdminOrderStatusCountsDto, [
  'incomplete',
  'notPaid',
  'submissionFailed',
] as const) {
  @ApiProperty({ minimum: 0, description: '기존 미답변 목록의 OPEN 질문 발생 수.' })
  unansweredQuestions!: number;
}

export class HomeAiPerformanceDto {
  @ApiProperty({ type: StageDropoffsDto }) stageDropoffs!: StageDropoffsDto;
  @ApiProperty({ type: RegistrationTimeDto }) registrationTime!: RegistrationTimeDto;
  @ApiProperty({ type: ComplaintCallsDto }) complaintCalls!: ComplaintCallsDto;
  @ApiProperty({ type: ResponseWaitDto }) responseWait!: ResponseWaitDto;
}

export class HomeDto {
  @ApiProperty({
    format: 'date-time',
    description: '조회용 DB 트랜잭션 시작 시각. 모든 영역은 같은 스냅샷으로 조회.',
  })
  observedAt!: Date;
  @ApiProperty({ type: HomePendingWorkDto }) pendingWork!: HomePendingWorkDto;
  @ApiProperty({
    type: [CallListItemDto],
    maxItems: 5,
    description: '기존 통화 목록과 같은 최신순, 최대 5개.',
  })
  recentCalls!: CallListItemDto[];
  @ApiProperty({
    type: [ParcelDraftResponseDto],
    maxItems: 5,
    description: 'INCOMPLETE 배송 초안 최신순, 최대 5개. 원본 삭제와 독립적인 보관 기준.',
  })
  incompleteDrafts!: ParcelDraftResponseDto[];
  @ApiProperty({
    type: [UnansweredQuestionDto],
    maxItems: 5,
    description: 'OPEN 질문. 기존 미답변 목록과 같은 통화 시작 오래된 순, 최대 5개.',
  })
  unansweredQuestions!: UnansweredQuestionDto[];
  @ApiProperty({
    type: HomeAiPerformanceDto,
    description: '기존 대시보드 4개와 동일한 고객 ALL·전체 보관 기간 기준. 미측정은 null.',
  })
  aiPerformance!: HomeAiPerformanceDto;
}

export class HomeResponseDto {
  @ApiProperty({ type: HomeDto }) data!: HomeDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
