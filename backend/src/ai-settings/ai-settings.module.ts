import { Module } from '@nestjs/common';
import { ApplicationConfigModule } from '../config/application-config.module';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { AiSettingsRepository } from './ai-settings.repository';
import { AiSettingsService } from './ai-settings.service';
import { AiPersonaClient } from './ai-persona.client';
import { PersonasController } from './personas.controller';
import { AiOptionsController } from './ai-options.controller';

@Module({
  imports: [ApplicationConfigModule, DatabaseModule, AuditModule],
  controllers: [PersonasController, AiOptionsController],
  providers: [AiSettingsRepository, AiSettingsService, AiPersonaClient],
})
export class AiSettingsModule {}
