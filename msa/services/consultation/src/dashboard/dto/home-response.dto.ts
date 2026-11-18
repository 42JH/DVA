import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, Min, Max } from 'class-validator';
import { DRAFT_STATUSES as PARCEL_DRAFT_STATUSES } from '@dva/events/parcel-drafts.cjs';
type ParcelDraftStatus = (typeof PARCEL_DRAFT_STATUSES)[number];
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { CallListItemDto } from '../../consultations/dto/call-response.dto';
import { UnansweredQuestionDto } from '../../unanswered-questions/dto/unanswered-question-list-response.dto';
import {
  ComplaintCallsDto,
  RegistrationTimeDto,
  ResponseWaitDto,
  StageDropoffsDto,
} from './dashboard-response.dto';

export class OriginPinDto {
  @ApiProperty({
    description:
      '신규 선택은 PERSONAL만 허용. COMPANY는 과거 주문 조회 및 동일 참조·주소를 유지하는 PATCH 호환용.',
    enum: ['PERSONAL', 'COMPANY'],
  })
  @IsIn(['PERSONAL', 'COMPANY'])
  scope!: 'PERSONAL' | 'COMPANY';

  @ApiProperty({
    description:
      '개인 주소록 번호. 과거 COMPANY 번호는 기존 주문의 논리 참조로만 보존.',
    minimum: 1,
    maximum: 2147483647,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  pinSeq!: number;
}

export class OrderAddressValueDto {
  @ApiProperty({
    description: '발송인 또는 수령인 이름.',
    type: String,
    nullable: true,
  })
  name!: string | null;

  @ApiProperty({
    description: '숫자 문자열 연락처. 선행 0 보존.',
    type: String,
    nullable: true,
  })
  phoneNumber!: string | null;

  @ApiProperty({ description: '도로명 주소.', type: String, nullable: true })
  roadAddress!: string | null;

  @ApiProperty({ description: '지번 주소.', type: String, nullable: true })
  jibunAddress!: string | null;

  @ApiProperty({ description: '상세 주소.', type: String, nullable: true })
  detailAddress!: string | null;

  @ApiProperty({ description: '읍·면·동 이름.', type: String, nullable: true })
  dongName!: string | null;

  @ApiProperty({
    description: '우편번호. 선행 0 보존.',
    type: String,
    nullable: true,
  })
  postalCode!: string | null;
}

export class DraftParcelSnapshotDto {
  @ApiProperty({
    description: '주문에 저장된 출발지. 미수집 필드는 null.',
    type: OrderAddressValueDto,
  })
  origin!: OrderAddressValueDto;

  @ApiProperty({
    description: '주문에 저장된 도착지. 미수집 필드는 null.',
    type: OrderAddressValueDto,
  })
  destination!: OrderAddressValueDto;

  @ApiProperty({
    description:
      '출발지 원본 주소록 참조. 원본의 현재 내용을 다시 읽지 않습니다.',
    type: OriginPinDto,
    nullable: true,
  })
  originPin!: OriginPinDto | null;

  @ApiProperty({ description: '서류 수량.', minimum: 0 })
  documentCount!: number;

  @ApiProperty({ description: '소형 박스 수량.', minimum: 0 })
  smallBoxCount!: number;

  @ApiProperty({ description: '중형 박스 수량.', minimum: 0 })
  mediumBoxCount!: number;

  @ApiProperty({ description: '대형 박스 수량.', minimum: 0 })
  bigBoxCount!: number;

  @ApiProperty({ description: '기타 물품 설명. 미입력 시 빈 문자열.' })
  otherItemDescription!: string;

  @ApiProperty({ description: '배송 요청 사항. 미입력 시 빈 문자열.' })
  clientComment!: string;

  @ApiProperty({
    description:
      '상세별 배송비(원). 취소 후에도 원래 금액 보존. 미수집 시 null.',
    minimum: 1,
    maximum: 2147483647,
    type: Number,
    nullable: true,
  })
  notifiedPrice!: number | null;

  @ApiProperty({
    description: '물품 가액(원). 미수집 시 null.',
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  itemPrice!: number | null;
}

export class ParcelDraftResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: '생성 당시 발신번호 사본. 원본 통화 삭제와 독립적으로 보존.',
  })
  callerPhoneNumber!: string | null;
  @ApiProperty() draftSeq!: number;
  @ApiProperty({
    type: Number,
    minimum: 1,
    description:
      'DV 표시용 예약 주문번호. 실제 주문 생성 전에도 존재하며 draftSeq로 초안을 조회합니다.',
  })
  reservedOrderSeq!: number;
  @ApiProperty({ type: Number, nullable: true }) callSessionSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) customerSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) createdByAdminUserSeq!:
    number | null;
  @ApiProperty({ format: 'uuid' }) clientParcelId!: string;
  @ApiProperty({ type: () => DraftParcelSnapshotDto })
  parcel!: DraftParcelSnapshotDto;
  @ApiProperty({ enum: PARCEL_DRAFT_STATUSES }) status!: ParcelDraftStatus;
  @ApiProperty() version!: number;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      '변경 응답의 최신 통화 초안 집합 버전. 관리자 단독 초안은 null.',
  })
  intakeVersion?: number | null;
  @ApiProperty({ type: Number, nullable: true }) sourceDraftSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) orderSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) orderParcelSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) legacyOrderSeq!: number | null;
  @ApiProperty({ type: Number, nullable: true }) legacyOrderParcelSeq!:
    number | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
  @ApiProperty({ format: 'date-time' }) retentionStartedAt!: Date;
}

export class HomePendingWorkDto {
  @ApiProperty({
    minimum: 0,
    description:
      '같은 조건의 INCOMPLETE 배송 초안 수. 초안 목록으로 이동합니다.',
  })
  incomplete!: number;
  @ApiProperty({ minimum: 0 }) notPaid!: number;
  @ApiProperty({ minimum: 0, description: 'SUBMISSION_FAILED 주문 수.' })
  submissionFailed!: number;
  @ApiProperty({
    minimum: 0,
    description: '기존 미답변 목록의 OPEN 질문 발생 수.',
  })
  unansweredQuestions!: number;
}

export class HomeAiPerformanceDto {
  @ApiProperty({ type: StageDropoffsDto }) stageDropoffs!: StageDropoffsDto;
  @ApiProperty({ type: RegistrationTimeDto })
  registrationTime!: RegistrationTimeDto;
  @ApiProperty({ type: ComplaintCallsDto }) complaintCalls!: ComplaintCallsDto;
  @ApiProperty({ type: ResponseWaitDto }) responseWait!: ResponseWaitDto;
}

export class HomeDto {
  @ApiProperty({
    format: 'date-time',
    description:
      '조회용 DB 트랜잭션 시작 시각. 모든 영역은 같은 스냅샷으로 조회.',
  })
  observedAt!: Date;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      'observedAt의 한국시간 오늘 생성된 실제 주문 수. 미완료 초안·이관 원본 제외.',
  })
  todayOrderCount!: number;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description:
      '한국시간 오늘 시작된 통화 수. 기존 목록의 PBX·AI·수신 시각 우선순위 적용.',
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
    description:
      'INCOMPLETE 배송 초안 최신순, 최대 11개. 원본 삭제와 독립적인 보관 기준.',
  })
  incompleteDrafts!: ParcelDraftResponseDto[];
  @ApiProperty({
    type: [UnansweredQuestionDto],
    maxItems: 11,
    description:
      'OPEN 질문. 기존 미답변 목록과 같은 통화 시작 오래된 순, 최대 11개.',
  })
  unansweredQuestions!: UnansweredQuestionDto[];
  @ApiProperty({
    type: HomeAiPerformanceDto,
    description:
      '기존 대시보드 4개와 동일한 고객 ALL·전체 보관 기간 기준. 미측정은 null.',
  })
  aiPerformance!: HomeAiPerformanceDto;
}

export class HomeResponseDto {
  @ApiProperty({ type: HomeDto }) data!: HomeDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
