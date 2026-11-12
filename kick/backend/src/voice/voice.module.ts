import { Module } from '@nestjs/common';

import { TestAccountGuard } from '../accounts/test-account.guard';
import { DatabaseModule } from '../database/database.module';
import { ElevenLabsService } from './elevenlabs.service';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [DatabaseModule],
  controllers: [VoiceController],
  providers: [VoiceService, ElevenLabsService, TestAccountGuard],
})
export class VoiceModule {}
