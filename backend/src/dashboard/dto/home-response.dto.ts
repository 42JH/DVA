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
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: 'observedAt의 한국시간 오늘 생성된 실제 주문 수. 미완료 초안·이관 원본 제외.',
  })
  todayOrderCount!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '한국시간 오늘 시작된 통화 수. 기존 목록의 PBX·AI·수신 시각 우선순위 적용.',
  })
  todayCallCount!: number;
  @ApiProperty({ type: HomePendingWorkDto }) pendingWork!: HomePendingWorkDto;
  @ApiProperty({
    type: [CallListItemDto],
    maxItems: 11,
    description: '기존 통화 목록과 같은 최신순, 최대 11개.',
  })
  recentCalls!: CallListItemDto[];
  @ApiProperty({
    type: [ParcelDraftResponseDto],
    maxItems: 11,
    description: 'INCOMPLETE 배송 초안 최신순, 최대 11개. 원본 삭제와 독립적인 보관 기준.',
  })
  incompleteDrafts!: ParcelDraftResponseDto[];
  @ApiProperty({
    type: [UnansweredQuestionDto],
    maxItems: 11,
    description: 'OPEN 질문. 기존 미답변 목록과 같은 통화 시작 오래된 순, 최대 11개.',
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
