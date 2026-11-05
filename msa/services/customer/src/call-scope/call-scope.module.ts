import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuditModule } from '../audit/audit.module';
import { CallScopeService } from './call-scope.service';

@Module({
  imports: [DatabaseModule, AuditModule],
  providers: [CallScopeService],
  exports: [CallScopeService],
})
export class CallScopeModule {}
