import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import {
  DROPOFF_STAGES,
  type DropoffStage,
  LATENCY_PROCESS_TYPES,
  type LatencyProcessType,
} from '../../call-insights/call-dashboard-metrics.types';
import {
  DASHBOARD_CUSTOMER_TYPES,
  type DashboardCustomerType,
} from './dashboard-query.dto';

export const DASHBOARD_COMPLAINT_TYPES = [
  'INFORMATION_RECOGNITION_ERROR',
  'INTENT_RECOGNITION_ERROR',
  'UNSUPPORTED_ANSWER',
  'SLOW_RESPONSE',
  'INTERRUPTION',
  'DISSATISFACTION_EXPRESSION',
] as const;

class DashboardCoverageDto {
  @ApiProperty({ enum: DASHBOARD_CUSTOMER_TYPES })
  customerType!: DashboardCustomerType;
  @ApiProperty({
    minimum: 0,
    description: '선택 고객의 보관 중인 종료 통화 수. 삭제/5년 만료 제외.',
  })
  endedCallCount!: number;
  @ApiProperty({
    minimum: 0,
    description: '집계 대상 중 고객 구분 미분류. NEW/EXISTING에서는 0.',
  })
  unclassifiedCustomerCallCount!: number;
}

export class StageDropoffItemDto {
  @ApiProperty({ enum: DROPOFF_STAGES.filter((stage) => stage !== 'NONE') })
  stage!: Exclude<DropoffStage, 'NONE'>;
  @ApiProperty({ minimum: 0 }) callCount!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 100,
    description:
      '해당 단계 이탈 / 이탈 판정 완료 종료 통화 × 100. 단계 진입 대비 비율이 아닙니다.',
  })
  dropoffRatePercent!: number | null;
}
export class StageDropoffsDto extends DashboardCoverageDto {
  @ApiProperty({ minimum: 0 }) assessedCallCount!: number;
  @ApiProperty({ minimum: 0 }) unassessedCallCount!: number;
  @ApiProperty({ minimum: 0 }) dropoffCallCount!: number;
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 100 })
  dropoffRatePercent!: number | null;
  @ApiProperty({ type: [StageDropoffItemDto] }) stages!: StageDropoffItemDto[];
}

export class PersonaRegistrationTimeDto {
  @ApiProperty() aiPersonaVersionSeq!: number;
  @ApiProperty() aiPersonaSeq!: number;
  @ApiProperty() name!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ minimum: 0 }) registrationCallCount!: number;
  @ApiProperty({ minimum: 0 }) registeredParcelCount!: number;
  @ApiProperty({ minimum: 0 }) totalCallDurationMs!: number;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 })
  averageSecondsPerParcel!: number | null;
}
export class PersonaRegistrationComparisonDto {
  @ApiProperty({
    type: PersonaRegistrationTimeDto,
    nullable: true,
    description: '서비스 전체 현재 ACTIVE 버전. 없는 경우 null.',
  })
  current!: PersonaRegistrationTimeDto | null;
  @ApiProperty({
    type: PersonaRegistrationTimeDto,
    nullable: true,
    description:
      '현재 버전 활성화 직전 ACTIVE였던 정확한 버전. 과거 미확인/첫 활성화는 null.',
  })
  previous!: PersonaRegistrationTimeDto | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '직전 평균 - 현재 평균(초/건). 양수면 현재가 빠름. 한쪽 측정 없음은 null.',
  })
  previousMinusCurrentSeconds!: number | null;
}
export class RegistrationTimeDto extends DashboardCoverageDto {
  @ApiProperty({ minimum: 0 }) registrationCallCount!: number;
  @ApiProperty({
    minimum: 0,
    description:
      '접수 건수 미수신 통화 수. 확인된 0건은 이 값에 포함하지 않음.',
  })
  unmeasuredCallCount!: number;
  @ApiProperty({ minimum: 0 }) registeredParcelCount!: number;
  @ApiProperty({
    minimum: 0,
    description: '접수 1건 이상인 통화의 전체 시간 합계.',
  })
  totalCallDurationMs!: number;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 })
  averageSecondsPerParcel!: number | null;
  @ApiProperty({ type: PersonaRegistrationComparisonDto })
  comparison!: PersonaRegistrationComparisonDto;
}

export class ComplaintTypeSummaryDto {
  @ApiProperty({ enum: DASHBOARD_COMPLAINT_TYPES })
  type!: (typeof DASHBOARD_COMPLAINT_TYPES)[number];
  @ApiProperty({
    minimum: 0,
    description: '같은 통화의 같은 유형은 한 번만 집계.',
  })
  callCount!: number;
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 100 })
  sharePercent!: number | null;
}
export class ComplaintCallsDto extends DashboardCoverageDto {
  @ApiProperty({ minimum: 0 }) assessedCallCount!: number;
  @ApiProperty({ minimum: 0 }) unassessedCallCount!: number;
  @ApiProperty({ minimum: 0 }) complaintCallCount!: number;
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 100 })
  complaintRatePercent!: number | null;
  @ApiProperty({
    minimum: 0,
    description:
      '화면 6개 유형별 통화 수 합계. 한 통화의 여러 유형은 각각 포함.',
  })
  typeTotalCount!: number;
  @ApiProperty({
    minimum: 0,
    description:
      '화면 6개 유형 외의 기존 분류가 있는 통화 수. 통화율에는 포함하며 도넛과 별도 표시.',
  })
  legacyTypeCallCount!: number;
  @ApiProperty({ type: [ComplaintTypeSummaryDto] })
  types!: ComplaintTypeSummaryDto[];
}

export class ResponseWaitProcessDto {
  @ApiProperty({ enum: LATENCY_PROCESS_TYPES })
  processType!: LatencyProcessType;
  @ApiProperty({ minimum: 0 }) measurementCount!: number;
  @ApiProperty({ minimum: 0 }) totalLatencyMs!: number;
  @ApiProperty({ type: Number, nullable: true, minimum: 0 }) averageLatencyMs!:
    number | null;
}
export class ResponseWaitDto extends DashboardCoverageDto {
  @ApiProperty({ minimum: 0 }) measuredCallCount!: number;
  @ApiProperty({ minimum: 0 }) unmeasuredCallCount!: number;
  @ApiProperty({
    minimum: 0,
    description:
      '수신 후 PBX 시각 보정 등으로 총 대기가 통화시간보다 커진 건수. 이 카드 집계에서 제외.',
  })
  invalidWaitCallCount!: number;
  @ApiProperty({ minimum: 0 }) totalWaitMs!: number;
  @ApiProperty({ minimum: 0 }) totalCallDurationMs!: number;
  @ApiProperty({ type: Number, nullable: true, minimum: 0, maximum: 100 })
  waitRatePercent!: number | null;
  @ApiProperty({ type: [ResponseWaitProcessDto] })
  processes!: ResponseWaitProcessDto[];
}

export class StageDropoffsResponseDto {
  @ApiProperty({ type: StageDropoffsDto }) data!: StageDropoffsDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class RegistrationTimeResponseDto {
  @ApiProperty({ type: RegistrationTimeDto }) data!: RegistrationTimeDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class ComplaintCallsResponseDto {
  @ApiProperty({ type: ComplaintCallsDto }) data!: ComplaintCallsDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class ResponseWaitResponseDto {
  @ApiProperty({ type: ResponseWaitDto }) data!: ResponseWaitDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
