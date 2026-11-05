import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ApplicationConfigModule } from './config/application-config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { CustomersModule } from './customers/customers.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { MembersModule } from './members/members.module';

@Module({
  imports: [
    ApplicationConfigModule,
    DatabaseModule,
    AuthModule,
    CustomersModule,
    OrganizationsModule,
    MembersModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
