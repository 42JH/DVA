import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ApplicationConfigModule } from './config/application-config.module';
import { CustomersModule } from './customers/customers.module';
import { DatabaseModule } from './database/database.module';
import { MembersModule } from './members/members.module';
import { OrganizationsModule } from './organizations/organizations.module';

@Module({
  imports: [
    ApplicationConfigModule,
    DatabaseModule,
    AuditModule,
    AuthModule,
    CustomersModule,
    OrganizationsModule,
    MembersModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
