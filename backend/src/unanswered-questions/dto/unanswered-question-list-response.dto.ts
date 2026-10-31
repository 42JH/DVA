import { ApiProperty } from '@nestjs/swagger';

export class UnansweredQuestionDto {
  @ApiProperty({ description: '질문 한 번 발생의 번호. FAQ 전환·삭제에 사용합니다.' })
  unansweredQuestionSeq!: number;

  @ApiProperty({ description: '질문이 발생한 통화 번호.' })
  callSessionSeq!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'PBX 우선, 없으면 AI 분석의 시작 시각. 모두 미수신이면 null.',
  })
  callStartedAt!: Date | null;

  @ApiProperty({ type: String, format: 'date-time', description: 'AI가 보고한 질문 발생 시각.' })
  occurredAt!: Date;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'AI 통화 시작부터 정수 초. 위치 미확인은 null이며 0과 구분합니다.',
  })
  offsetSeconds!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '연결 주문의 고객 우선, 없으면 발신번호와 연결한 현재 고객.',
  })
  customerSeq!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '연결 고객의 현재 이름. 과거 이름 스냅샷이 아닙니다.',
  })
  customerName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: '통화에 저장된 발신번호.' })
  callerPhoneNumber!: string | null;

  @ApiProperty({ maxLength: 1000, description: '수집한 질문 원문. HTML로 해석하지 않는 평문.' })
  questionText!: string;

  @ApiProperty({
    enum: ['OPEN', 'REGISTERED'],
    description: '현재 업무 처리 상태. 삭제한 질문은 제외합니다.',
  })
  status!: 'OPEN' | 'REGISTERED';

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'AI 분석에 보고한 실제 사용 버전. 현재 활성 버전으로 대체하지 않습니다.',
  })
  aiPersonaVersionSeq!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '전환한 FAQ가 현재 존재하면 번호, 삭제됐거나 미전환이면 null. 전환 상태와 DB 이력은 유지합니다.',
  })
  faqEntrySeq!: number | null;
}

export class UnansweredQuestionListResponseDto {
  @ApiProperty({
    type: [UnansweredQuestionDto],
    description: '오래된 통화부터 정렬한 질문 목록. 시작 시각 미확인은 뒤에 표시합니다.',
  })
  data!: UnansweredQuestionDto[];

  @ApiProperty({ description: '같은 검색 조건의 다음 결과 존재 여부.' })
  hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
