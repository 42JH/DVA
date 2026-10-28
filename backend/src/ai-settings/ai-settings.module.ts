import { Module } from '@nestjs/common';
import { ApplicationConfigModule } from '../config/application-config.module';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { AiSettingsRepository } from './ai-settings.repository';
import { AiSettingsService } from './ai-settings.service';
import { AiPersonaClient } from './ai-persona.client';
import { PersonasController } from './personas.controller';
import { AiOptionsController } from './ai-options.controller';
import { AiRuntimeController } from './ai-runtime.controller';
import { AiSettingsGuard } from './ai-settings-access';
import { PersonaApplicationService } from './persona-application.service';

@Module({
  imports: [ApplicationConfigModule, DatabaseModule, AuditModule],
  controllers: [PersonasController, AiOptionsController, AiRuntimeController],
  providers: [
    AiSettingsRepository,
    AiSettingsService,
    AiPersonaClient,
    AiSettingsGuard,
    PersonaApplicationService,
  ],
})
export class AiSettingsModule {}
