import { PaymentCardsModule } from '../payments/payment-cards.module';
import { Module } from '@nestjs/common';
import { MembersModule } from '../members/members.module';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { DepartmentsRepository } from './departments.repository';
import { OrganizationBillingRepository } from './organization-billing.repository';
import { OrganizationBillingService } from './organization-billing.service';
import { OrganizationDeletionService } from './organization-deletion.service';
import { OrganizationDeletionRepository } from './organization-deletion.repository';

// AppModule's AuthModule provides the global session/CSRF guard for every company route.
@Module({
  imports: [DatabaseModule, AuditModule, MembersModule, PaymentCardsModule],
  controllers: [OrganizationsController, DepartmentsController],
  providers: [
    OrganizationDeletionService,
    OrganizationDeletionRepository,
    OrganizationsService,
    OrganizationsRepository,
    DepartmentsService,
    DepartmentsRepository,
    OrganizationBillingRepository,
    OrganizationBillingService,
  ],
  exports: [OrganizationsService, OrganizationBillingService],
})
export class OrganizationsModule {}
