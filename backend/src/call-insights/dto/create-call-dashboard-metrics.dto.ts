import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  DROPOFF_STAGES,
  DropoffStage,
  LATENCY_PROCESS_TYPES,
  LatencyProcessType,
} from '../call-dashboard-metrics.types';

class CallMetricIdentityDto {
  @ApiProperty({ description: '통화에 저장된 AI 통화 ID.', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\s\u0000]+$/)
  providerCallId!: string;
}

export class CreateStageMetricsDto extends CallMetricIdentityDto {
  @ApiProperty({ enum: DROPOFF_STAGES, description: '이탈 단계 하나. NONE은 이탈 없이 종료.' })
  @IsIn(DROPOFF_STAGES)
  dropoffStage!: DropoffStage;
}

export class CallLatencyStatDto {
  @ApiProperty({ enum: LATENCY_PROCESS_TYPES })
  @IsIn(LATENCY_PROCESS_TYPES)
  processType!: LatencyProcessType;

  @ApiProperty({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: '유형별 레이턴시 합계(밀리초).',
  })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  totalLatencyMs!: number;

  @ApiProperty({
    minimum: 1,
    maximum: 2147483647,
    description: '실제 측정 횟수. 미측정 유형은 배열에서 생략.',
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  measurementCount!: number;
}

export class CreateResponseWaitMetricsDto extends CallMetricIdentityDto {
  @ApiProperty({
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'AI가 겹침을 제외한 통화 전체 대기 밀리초. 측정 후 없음은 0.',
  })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  totalWaitMs!: number;

  @ApiProperty({
    type: [CallLatencyStatDto],
    maxItems: 7,
    description: '유형별 최종 요약. 유형 중복 금지, 측정 후 없음은 [].',
  })
  @IsArray()
  @ArrayMaxSize(7)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => CallLatencyStatDto)
  latencyStats!: CallLatencyStatDto[];
}
