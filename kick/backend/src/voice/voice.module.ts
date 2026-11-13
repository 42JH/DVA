import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { DatabaseModule } from '../database/database.module';
import { ElevenLabsService } from './elevenlabs.service';
import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [DatabaseModule, AccountsModule],
  controllers: [VoiceController],
  providers: [VoiceService, ElevenLabsService],
})
export class VoiceModule {}
