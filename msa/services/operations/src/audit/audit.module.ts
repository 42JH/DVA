import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditFailureInterceptor } from './audit-failure.interceptor';
import { DatabaseModule } from '../database/database.module';
import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';
import { AuditEventsController } from './audit-events.controller';
import { ServiceAuditReceiver } from './service-audit.receiver';

@Module({
  imports: [DatabaseModule],
  controllers: [AuditController, AuditEventsController],
  providers: [
    AuditRepository,
    ServiceAuditReceiver,
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditFailureInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
