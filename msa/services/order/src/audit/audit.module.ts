import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditFailureInterceptor } from './audit-failure.interceptor';
import { DatabaseModule } from '../database/database.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [AuditController],
  providers: [AuditService, { provide: APP_INTERCEPTOR, useClass: AuditFailureInterceptor }],
  exports: [AuditService],
})
export class AuditModule {}
