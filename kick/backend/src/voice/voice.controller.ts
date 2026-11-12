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
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { type AccountRequest, TestAccountGuard } from '../accounts/test-account.guard';
import { VoiceService } from './voice.service';

const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });

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
    if (
      typeof body !== 'object' ||
      body === null ||
      Object.keys(body).length !== 1 ||
      !('text' in body) ||
      typeof body.text !== 'string'
    ) {
      throw new BadRequestException('Expected text');
    }
    const text = body.text.trim();
    if (!text || text.length > 200 || [...segmenter.segment(text)].length > 20) {
      throw new BadRequestException('Text must contain 1 to 20 characters');
    }
    const audio = await this.voiceService.speech(request.accountId, text);
    return new StreamableFile(audio, { type: 'audio/mpeg' });
  }

  @Delete()
  @HttpCode(204)
  delete(@Req() request: AccountRequest) {
    return this.voiceService.delete(request.accountId);
  }
}
