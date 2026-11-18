import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { PinsController } from './pins.controller';
import { PinsRepository } from './pins.repository';
import { PinsService } from './pins.service';

@Module({
  imports: [DatabaseModule, AuditModule],
  controllers: [PinsController],
  providers: [PinsRepository, PinsService],
})
export class PinsModule {}
