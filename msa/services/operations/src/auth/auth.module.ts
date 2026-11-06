import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from '../database/database.module';
import { AdminsModule } from '../admins/admins.module';
import { AuditModule } from '../audit/audit.module';
import { ApplicationConfigModule } from '../config/application-config.module';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AuthGuard } from './auth.guard';
import { AuthController } from './auth.controller';
import { AdminAccessController } from './admin-access.controller';
import { InternalAuthController } from './internal-auth.controller';
import { AuthLimitsService } from './auth-limits.service';
import { AuthLimitsGuard } from './auth-limits.guard';
@Module({
  imports: [ApplicationConfigModule, DatabaseModule, AdminsModule, AuditModule],
  controllers: [AuthController, AdminAccessController, InternalAuthController],
  providers: [
    AuthRepository,
    AuthService,
    AuthLimitsService,
    AuthLimitsGuard,
    { provide: APP_GUARD, useExisting: AuthLimitsGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
