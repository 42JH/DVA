import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { ORDER_STATUSES, type OrderStatus } from '@dva/events/order-read.cjs';
import { CallAnalysisDto } from './call-analysis-response.dto';

export class CallDto {
  @ApiProperty({
    enum: ['PENDING', 'COMPLETED', 'FAILED', 'EXPIRED'],
    description:
      '정상 분석 저장이면 COMPLETED 우선, 없고 AI 최종 실패 통보가 있으면 FAILED. 둘 다 없고 PBX 통화 종료 후 10분 이상이면 EXPIRED, 그 외 PENDING. 시간 경과만으로 완료 처리하지 않습니다.',
  })
  analysisStatus!: 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      '최초 녹취 참조의 DB 저장 시각. 실제 녹음 시작과 다르며 녹취가 없으면 null.',
  })
  recordedAt!: Date | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '연결 주문 고객 우선, 없으면 발신번호와 일치한 고객 번호.',
  })
  customerSeq!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '연결 고객의 현재 이름. 미확인은 null.',
  })
  customerName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      '연결 고객의 현재 소속 기업명. 비활성 소속·기업도 표시하며 미연결·삭제 시 null. 통화 당시 기업명이나 결제 기업 스냅샷과 다릅니다.',
  })
  organizationName!: string | null;

  @ApiProperty({
    enum: ORDER_STATUSES,
    nullable: true,
    description: '연결 주문의 현재 결제·접수 상태. 통화 종료 사유와 별개.',
  })
  orderStatus!: OrderStatus | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '연결 주문의 현재 결제 금액(원).',
  })
  orderTotalAmount!: number | null;
  @ApiProperty({
    description: '통화 번호(call_sessions.call_session_seq).',
    example: 12,
  })
  callSessionSeq!: number;

  @ApiProperty({
    description: 'OpenAI 통화 식별자. PBX 녹취 ID와 다릅니다.',
    example: 'rtc_example',
  })
  providerCallId!: string;

  @ApiProperty({
    description: '통화 발신번호. 미확인 시 null.',
    type: String,
    nullable: true,
    example: '01012345678',
  })
  callerPhoneNumber!: string | null;

  @ApiProperty({
    description: '연결 주문 번호. 주문이 없으면 null.',
    type: Number,
    nullable: true,
    example: 10,
  })
  orderSeq!: number | null;

  @ApiProperty({
    description:
      '표시·기간 검색 기준 시작 시각. PBX 시작, AI 시작, 수신 이벤트 시각 순으로 사용하며 모두 없으면 null.',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-28T01:00:00.000Z',
  })
  startedAt!: Date | null;

  @ApiProperty({
    description:
      'PBX 종료 시각 우선, 미수집이면 AI 종료 시각. 모두 없으면 null이며 null만으로 통화 진행 중이라고 판단하지 않습니다.',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-28T01:03:00.000Z',
  })
  endedAt!: Date | null;
}

export class CallListItemDto extends CallDto {
  @ApiProperty({
    type: CallAnalysisDto,
    nullable: true,
    description: '저장된 통화 분석. 아직 수신하지 않았으면 null.',
  })
  analysis!: CallAnalysisDto | null;
}

export class CallListResponseDto {
  @ApiProperty({ description: '통화 목록.', type: [CallListItemDto] })
  data!: CallListItemDto[];

  @ApiProperty({ description: '다음 페이지 존재 여부.', example: false })
  hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}

export class RecordingDto {
  @ApiProperty({
    description: '녹취 번호(recordings.recording_seq).',
    example: 7,
  })
  recordingSeq!: number;

  @ApiProperty({
    description: '녹취 참조가 DB에 저장된 시각. 통화 시작 시각과 다릅니다.',
    type: String,
    format: 'date-time',
    example: '2026-10-28T01:04:00.000Z',
  })
  createdAt!: Date;

  @ApiProperty({
    description:
      '비공개 S3 녹취의 임시 재생 URL. 최대 5분 유효하며 발급 실패 시 null.',
    type: String,
    format: 'uri',
    nullable: true,
    example:
      'https://recordings.example.test/recordings/example?X-Amz-Algorithm=AWS4-HMAC-SHA256&...',
  })
  url!: string | null;

  @ApiProperty({
    description:
      'URL 만료 시각. AWS 자격 증명이 먼저 만료되면 그 시각에 맞춥니다. 발급 실패 시 null.',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-28T01:09:00.000Z',
  })
  expiresAt!: Date | null;

  @ApiProperty({
    description:
      '발급 성공 시 null. NOT_FOUND 파일 없음, DEPENDENCY_UNAVAILABLE S3 설정·권한·연결·서명 실패.',
    type: String,
    enum: ['NOT_FOUND', 'DEPENDENCY_UNAVAILABLE'],
    nullable: true,
  })
  playbackError!: 'NOT_FOUND' | 'DEPENDENCY_UNAVAILABLE' | null;
}

export class CallDetailDto {
  @ApiProperty({
    description: '통화 기본 정보와 상담원 연결 기록.',
    type: CallDto,
  })
  call!: CallDto;

  @ApiProperty({
    type: CallAnalysisDto,
    nullable: true,
    description: '저장된 통화 분석. 아직 수신하지 않았으면 null.',
  })
  analysis!: CallAnalysisDto | null;

  @ApiProperty({
    minimum: 0,
    description:
      '현재 수집된 AI 동작 전체 건수. 동작 조회의 페이지 크기와 별개.',
  })
  aiActionCount!: number;

  @ApiProperty({
    description: '녹취별 재생 URL·만료 시각·오류. 미수집·미연결이면 빈 배열.',
    type: [RecordingDto],
  })
  recordings!: RecordingDto[];
}

export class CallDetailResponseDto {
  @ApiProperty({ description: '통화 상세.', type: CallDetailDto })
  data!: CallDetailDto;

  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto })
  meta!: RequestMetaDto;
}
