import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import { type AccountRequest, TestAccountGuard } from '../accounts/test-account.guard';
import { type SpeechSettings } from './elevenlabs.service';
import { VoiceService } from './voice.service';

const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const maxSpeechCharacters = 50;

function speechText(body: unknown, allowSettings = false): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    Object.keys(body).some((key) => key !== 'text' && !(allowSettings && key === 'settings')) ||
    !('text' in body) ||
    typeof body.text !== 'string'
  ) {
    throw new BadRequestException('Expected text');
  }
  const text = body.text.trim();
  if (!text || text.length > 1_000 || [...segmenter.segment(text)].length > maxSpeechCharacters) {
    throw new BadRequestException(`Text must contain 1 to ${maxSpeechCharacters} characters`);
  }
  return text;
}

function speechSettings(value: unknown): SpeechSettings | undefined {
  if (value === undefined) return;
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some(
      (key) => !['model', 'speed', 'stability', 'similarityBoost', 'style'].includes(key),
    ) ||
    Array.isArray(value)
  ) {
    throw new BadRequestException('Expected speech settings');
  }
  const { model, speed, stability, similarityBoost, style } = value as Record<string, unknown>;
  if (model !== undefined && model !== 'eleven_flash_v2_5' && model !== 'eleven_multilingual_v2') {
    throw new BadRequestException('Unsupported speech model');
  }
  if (style !== undefined && model !== 'eleven_multilingual_v2') {
    throw new BadRequestException('Style requires Multilingual v2');
  }
  const setting = (number: unknown, name: string, min = 0, max = 1): number | undefined => {
    if (number === undefined) return;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max) {
      throw new BadRequestException(`${name} must be between ${min} and ${max}`);
    }
    return number;
  };
  return {
    model,
    speed: setting(speed, 'Speed', 0.7, 1.2),
    stability: setting(stability, 'Stability'),
    similarityBoost: setting(similarityBoost, 'Similarity boost'),
    style: setting(style, 'Style'),
  };
}

@Controller('api/voice')
@UseGuards(TestAccountGuard)
export class VoiceController {
  constructor(private readonly voiceService: VoiceService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@Req() request: AccountRequest) {
    return this.voiceService.status(request.accountId);
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('audio', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 1, fieldSize: 16, parts: 3 },
    }),
  )
  clone(
    @Req() request: AccountRequest,
    @Body('consent') consent: unknown,
    @UploadedFile() audio?: { buffer: Buffer; mimetype: string },
  ) {
    if (consent !== 'true') {
      throw new BadRequestException('Voice cloning consent is required');
    }
    if (!audio || audio.buffer.length < 12) {
      throw new BadRequestException('A WAV or MP3 audio sample is required');
    }
    const { buffer, mimetype } = audio;
    const wav =
      (mimetype === 'audio/wav' || mimetype === 'audio/x-wav') &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WAVE';
    const mp3 =
      mimetype === 'audio/mpeg' &&
      (buffer.toString('ascii', 0, 3) === 'ID3' ||
        (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0));
    if (!wav && !mp3) {
      throw new BadRequestException('A WAV or MP3 audio sample is required');
    }
    return this.voiceService.clone(request.accountId, {
      buffer,
      mimetype: wav ? 'audio/wav' : 'audio/mpeg',
    });
  }

  @Post('speech')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async speech(@Req() request: AccountRequest, @Body() body: unknown): Promise<StreamableFile> {
    const audio = await this.voiceService.speech(request.accountId, speechText(body));
    return new StreamableFile(audio, { type: 'audio/mpeg' });
  }

  @Post('speech/stream')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async streamSpeech(
    @Req() request: AccountRequest,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const text = speechText(body, true);
    const settings = speechSettings((body as { settings?: unknown }).settings);
    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    try {
      const audio = await this.voiceService.streamSpeech(
        request.accountId,
        text,
        controller.signal,
        settings,
      );
      const first = await audio.next();
      response.setHeader('Content-Type', 'audio/pcm');
      response.setHeader('X-Accel-Buffering', 'no');
      // pipeline aborts the HTTP response on failure so partial audio cannot look like a complete stream.
      await pipeline(
        async function* () {
          yield first.value;
          yield* audio;
        },
        response,
        { signal: controller.signal },
      );
    } catch (error) {
      if (!response.destroyed) {
        throw error;
      }
    } finally {
      response.off('close', abort);
      abort();
    }
  }

  @Delete()
  @HttpCode(204)
  delete(@Req() request: AccountRequest) {
    return this.voiceService.delete(request.accountId);
  }
}
