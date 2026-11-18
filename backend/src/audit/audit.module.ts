import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditFailureInterceptor } from './audit-failure.interceptor';
import { DatabaseModule } from '../database/database.module';
import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuditController],
  providers: [
    AuditRepository,
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditFailureInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
