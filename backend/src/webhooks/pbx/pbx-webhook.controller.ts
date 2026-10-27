import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiBearerAuth,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiConflictResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import { PbxWebhookGuard } from './pbx-webhook.guard';
import { parseCallEndedPayload } from './pbx-webhook.payload';
import { PbxWebhookService } from './pbx-webhook.service';

@ApiTags('PBX')
@Controller('webhooks/pbx')
export class PbxWebhookController {
  constructor(private readonly webhooks: PbxWebhookService) {}

  @Post('call-ended')
  @HttpCode(200)
  @UseGuards(PbxWebhookGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: '통화 종료·녹취 웹훅 수신',
    description:
      'DB에 수신 내역을 저장하면 즉시 응답합니다. 녹취 다운로드·S3 저장은 비동기이며, received는 업로드 완료를 뜻하지 않습니다. 같은 recordingId·본문은 중복 수신으로 응답합니다.\n\n발신번호와 시작 시각으로 유일한 통화를 찾고 연결을 고정합니다. 매칭 보류·저장 실패는 수신함에 남겨 재처리합니다.',
    servers: [
      { url: '/api', description: 'Nginx 경유' },
      { url: '/', description: 'NestJS 직접 연결' },
    ],
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: [
        'recordingId',
        'callFrom',
        'callTo',
        'startedAt',
        'endedAt',
        'durationSeconds',
        'recordingUrl',
      ],
      properties: {
        recordingId: {
          type: 'string',
          maxLength: 200,
          description: 'PBX 녹취 고유 ID. 재시도 시 유지.',
          example: 'recording-example',
        },
        callFrom: {
          type: 'string',
          description: '발신번호. 숫자 또는 +국가번호.',
          example: '01012345678',
        },
        callTo: { type: 'string', description: '수신번호.', example: '07012345678' },
        startedAt: {
          type: 'string',
          format: 'date-time',
          description: 'PBX 실제 시작 시각. 시간대 필수.',
          example: '2026-10-27T01:00:00Z',
        },
        endedAt: {
          type: 'string',
          format: 'date-time',
          description: 'PBX 실제 종료 시각. 시작 시각 이상.',
          example: '2026-10-27T01:03:00Z',
        },
        durationSeconds: {
          type: 'integer',
          minimum: 0,
          maximum: 2147483647,
          description: 'PBX 통화 길이(초).',
          example: 180,
        },
        recordingUrl: {
          type: 'string',
          format: 'uri',
          maxLength: 8192,
          description:
            '인증 없이 GET 가능한 HTTPS 녹취 URL 또는 서명 URL. 설정된 다운로드 호스트만 허용.',
          example:
            'https://dvercorp-aicc-connect-dev-recordings.s3.ap-northeast-2.amazonaws.com/example.mp3',
        },
      },
    },
  })
  @ApiOkResponse({
    description: '수신함 저장 완료. 업무 API의 data/meta 포장 없이 기존 PBX 응답 유지.',
    schema: {
      type: 'object',
      required: ['status', 'recordingId', 'duplicate'],
      properties: {
        status: { type: 'string', enum: ['received'] },
        recordingId: { type: 'string' },
        duplicate: { type: 'boolean', description: '동일 녹취를 이미 수신했으면 true.' },
      },
    },
  })
  @ApiBadRequestResponse({ description: '필수 값·시각·HTTPS URL 형식 오류.' })
  @ApiUnauthorizedResponse({ description: 'PBX Bearer 토큰 누락 또는 불일치.' })
  @ApiConflictResponse({ description: '같은 recordingId를 다른 본문으로 재사용함.' })
  @ApiServiceUnavailableResponse({
    description: 'PBX 토큰 미설정 또는 수신함 저장 실패. 재시도 필요.',
  })
  receive(@Body() body: unknown) {
    return this.webhooks.receive(parseCallEndedPayload(body));
  }
}
