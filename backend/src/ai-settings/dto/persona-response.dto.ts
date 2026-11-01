import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { APPLY_ERRORS, PERSONA_STATUSES, TURN_WAIT_LEVELS } from '../ai-settings.types';

export class PersonaVersionDto {
  @ApiProperty({ description: '페르소나 번호.', example: 1 })
  aiPersonaSeq!: number;
  @ApiProperty({ description: '고유 코드.', example: 'parcel' })
  code!: string;
  @ApiProperty({ description: '전체 설정 버전의 DB 식별자.', example: 3 })
  aiPersonaVersionSeq!: number;
  @ApiProperty({ description: '페르소나 안의 버전 번호.', example: 2 })
  version!: number;
  @ApiProperty({ description: '이 버전의 표시명.', example: '친절한 택배 상담원' })
  name!: string;
  @ApiProperty({
    description: '수정 없이 보존한 전체 프롬프트.',
    example: '차분한 한국어로 택배 접수를 안내합니다.',
  })
  promptText!: string;
  @ApiProperty({ description: '음성 ID. null은 AI 기본 음성.', type: String, nullable: true })
  voiceId!: string | null;
  @ApiProperty({ description: '발화 속도. null은 AI 기본 속도.', type: Number, nullable: true })
  speakingRate!: number | null;
  @ApiProperty({ description: '말끝 대기 단계.', enum: TURN_WAIT_LEVELS })
  turnWaitLevel!: string;
  @ApiProperty({
    description:
      'ACTIVE 적용 완료, PENDING 반영 대기, INACTIVE 미사용. ACTIVE·PENDING은 전체에서 각각 최대 1개.',
    enum: PERSONA_STATUSES,
  })
  status!: string;
  @ApiProperty({ description: '버전 작성 관리자.', type: Number, nullable: true })
  createdByAdminUserSeq!: number | null;
  @ApiPropertyOptional({
    description:
      '관리자 페르소나 응답의 작성자 이름. 논리 참조와 기존 감사 이력으로 조회하며 관리자 삭제 후에도 보존합니다. 확인할 수 없는 과거 작성자는 null. AI 설정 응답에는 제공하지 않습니다.',
    type: String,
    nullable: true,
  })
  createdByAdminUserName?: string | null;
  @ApiProperty({ description: '버전 생성 시각.', type: String, format: 'date-time' })
  createdAt!: Date;
  @ApiProperty({
    description: '최신 적용 요청 UUID. 미요청은 null. 인증 토큰이 아닙니다.',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  applicationId!: string | null;
  @ApiProperty({ description: '최신 적용 요청 관리자.', type: Number, nullable: true })
  requestedByAdminUserSeq!: number | null;
  @ApiProperty({
    description: '최신 적용 요청 시각.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  requestedAt!: Date | null;
  @ApiProperty({
    description: 'AI 적용 성공을 확인한 시각. 요청 중에는 null.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  appliedAt!: Date | null;
  @ApiProperty({
    description: '마지막 AI 알림 시도 시각. 전송 성공이나 적용 완료를 의미하지 않습니다.',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  lastNotifiedAt!: Date | null;
  @ApiProperty({
    description: '반영 오류. 오류여도 PENDING과 기존 ACTIVE를 유지합니다.',
    enum: ['AI_UNAVAILABLE', ...APPLY_ERRORS],
    nullable: true,
  })
  applyErrorCode!: string | null;
}

export class PersonaDto {
  @ApiProperty({ description: '페르소나 번호.', example: 1 })
  aiPersonaSeq!: number;
  @ApiProperty({ description: '변경하지 않는 고유 코드.', example: 'parcel' })
  code!: string;
  @ApiProperty({
    description: '최신 저장 버전. 운영 적용 버전과 다를 수 있습니다.',
    type: PersonaVersionDto,
  })
  latestVersion!: PersonaVersionDto;
  @ApiProperty({
    description:
      '이 유형의 최신 저장 버전 HEAD. 생성·수정 저장 시 자동 이동하며 latestVersion과 같습니다. 실제 상담 적용·대기 버전은 별도입니다.',
    type: PersonaVersionDto,
  })
  headVersion!: PersonaVersionDto;
  @ApiProperty({
    description: '실제 AI 적용을 확인한 상담 버전. HEAD가 이동해도 유지하며 미사용 유형은 null.',
    type: PersonaVersionDto,
    nullable: true,
  })
  activeVersion!: PersonaVersionDto | null;
  @ApiProperty({
    description:
      'publish 요청 시 고정한 적용 대기 버전. 저장으로 교체되지 않으며 applyErrorCode로 반영 실패를 확인합니다. 없으면 null.',
    type: PersonaVersionDto,
    nullable: true,
  })
  pendingVersion!: PersonaVersionDto | null;
  @ApiProperty({
    description: '이 페르소나의 현재 적용 버전 식별자. 미적용은 null.',
    type: Number,
    nullable: true,
  })
  activeVersionSeq!: number | null;
  @ApiProperty({
    description: '이 페르소나의 대기 버전 식별자. 없으면 null.',
    type: Number,
    nullable: true,
  })
  pendingVersionSeq!: number | null;
}

export class PersonaResponseDto {
  @ApiProperty({ description: '페르소나 상세.', type: PersonaDto })
  data!: PersonaDto;
  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto })
  meta!: RequestMetaDto;
}
export class PersonaVersionResponseDto {
  @ApiProperty({ description: '전체 설정 버전.', type: PersonaVersionDto })
  data!: PersonaVersionDto;
  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto })
  meta!: RequestMetaDto;
}
export class PersonaListResponseDto {
  @ApiProperty({ description: '최신 페르소나 번호순 목록.', type: [PersonaDto] })
  data!: PersonaDto[];
  @ApiProperty({ description: '다음 페이지 존재 여부.' })
  hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
export class PersonaVersionsResponseDto {
  @ApiProperty({ description: '버전 내림차순 전체 설정 이력.', type: [PersonaVersionDto] })
  data!: PersonaVersionDto[];
  @ApiProperty({ description: '다음 페이지 존재 여부.' })
  hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
export class VoiceOptionDto {
  @ApiProperty({ description: 'AI에 전달할 음성 ID.' })
  id!: string;
  @ApiProperty({ description: '음성 표시명.' })
  label!: string;
}
export class SpeakingRateOptionDto {
  @ApiProperty({
    description: '최소 속도. 미지원이면 min·max 모두 null.',
    type: Number,
    nullable: true,
  })
  min!: number | null;
  @ApiProperty({
    description: '최대 속도. 범위가 없으면 숫자 입력 불가.',
    type: Number,
    nullable: true,
  })
  max!: number | null;
}
export class AiOptionsDto {
  @ApiProperty({
    description: 'AI가 지원하는 음성 목록. null은 기본 음성으로 별도 허용.',
    type: [VoiceOptionDto],
  })
  voices!: VoiceOptionDto[];
  @ApiProperty({ description: '실제 지원하는 숫자 속도 범위.', type: SpeakingRateOptionDto })
  speakingRate!: SpeakingRateOptionDto;
  @ApiProperty({
    description: '실제 지원하는 말끝 대기 단계 목록.',
    enum: TURN_WAIT_LEVELS,
    isArray: true,
  })
  turnWaitLevels!: string[];
}
export class AiOptionsResponseDto {
  @ApiProperty({ description: 'AI 서버에서 확인한 지원 옵션.', type: AiOptionsDto })
  data!: AiOptionsDto;
  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto })
  meta!: RequestMetaDto;
}
