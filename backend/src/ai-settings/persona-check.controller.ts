import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCookieAuth,
  ApiParam,
  ApiProduces,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Roles } from '../auth/auth.guard';
import { RequestMetaDto } from '../common/dto/api-response.dto';
import { ApiException } from '../common/errors/api.exception';
import {
  PersonaCheckResultParams,
  PersonaCheckRunParams,
  PersonaCheckRunsQuery,
  PersonaCheckScenarioParams,
  StartPersonaCheckRunDto,
} from './dto/persona-check.dto';
import { PersonaCheckClient } from './persona-check.client';

const audioHeaders = [
  'Content-Type',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
  'ETag',
  'Last-Modified',
];

@ApiTags('Persona Check')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@Controller('persona-check')
export class PersonaCheckController {
  constructor(private readonly client: PersonaCheckClient) {}

  @Get('scenarios')
  scenarios() {
    return this.client.json('/scenarios');
  }

  @Get('scenarios/:id')
  scenario(@Param() { id }: PersonaCheckScenarioParams) {
    return this.client.json(`/scenarios/${id}`);
  }

  @Get('runs')
  runs(@Query() { tag }: PersonaCheckRunsQuery) {
    const query = tag === undefined ? '' : '?' + new URLSearchParams({ tag }).toString();
    return this.client.json(`/runs${query}`);
  }

  @Post('runs')
  @HttpCode(202)
  @ApiAcceptedResponse({ description: '시험 실행이 접수되었습니다.' })
  start(@Body() input: StartPersonaCheckRunDto) {
    return this.client.json('/runs', 'POST', input);
  }

  @Post('runs/:runId/stop')
  @HttpCode(202)
  @ApiParam({ name: 'runId', type: String })
  @ApiAcceptedResponse({
    description: '시험 멈춤이 접수되었습니다.',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { runId: { type: 'string' } },
        },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  stop(@Param() { runId }: PersonaCheckRunParams) {
    return this.client.json(`/runs/${runId}/stop`, 'POST');
  }

  @Get('runs/:runId')
  run(@Param() { runId }: PersonaCheckRunParams) {
    return this.client.json(`/runs/${runId}`);
  }

  @Get('runs/:runId/:scenario/verdict')
  verdict(@Param() { runId, scenario }: PersonaCheckResultParams) {
    return this.client.json(`/runs/${runId}/${scenario}/verdict`);
  }

  @Get('runs/:runId/:scenario/record')
  record(@Param() { runId, scenario }: PersonaCheckResultParams) {
    return this.client.json(`/runs/${runId}/${scenario}/record`);
  }

  @Get('runs/:runId/:scenario/audio')
  @ApiProduces('audio/wav')
  @ApiResponse({ status: 206, description: '요청한 녹음 범위를 반환합니다.' })
  async audio(
    @Param() { runId, scenario }: PersonaCheckResultParams,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    response.once('close', disconnect);
    try {
      const result = await this.client.audio(
        `/runs/${runId}/${scenario}/audio`,
        request.get('Range'),
        abort,
      );
      if ('contentRange' in result) {
        if (result.contentRange) response.setHeader('Content-Range', result.contentRange);
        throw new ApiException(416, 'INVALID_REQUEST', '요청한 녹음 범위를 반환할 수 없습니다.');
      }
      for (const name of audioHeaders) {
        const value = result.response.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.status(result.response.status);
      // A failed transfer closes the partial WAV once streaming has started.
      await pipeline(Readable.fromWeb(result.body), response).catch(() => response.destroy());
    } finally {
      response.off('close', disconnect);
    }
  }
}
