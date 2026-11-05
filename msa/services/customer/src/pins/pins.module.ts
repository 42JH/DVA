import { CallScopeModule } from '../call-scope/call-scope.module';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { PinsController } from './pins.controller';
import { PinsRepository } from './pins.repository';
import { PinsService } from './pins.service';

@Module({
  imports: [DatabaseModule, AuditModule, CallScopeModule],
  controllers: [PinsController],
  providers: [PinsRepository, PinsService],
  exports: [PinsService],
})
export class PinsModule {}
