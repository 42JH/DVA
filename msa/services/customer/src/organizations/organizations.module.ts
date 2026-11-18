import { PaymentCardsModule } from '../payments/payment-cards.module';
import { BillingScopeController } from './billing-scope.controller';
import { OrganizationBillingService } from './organization-billing.service';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationsRepository } from './organizations.repository';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { DepartmentsRepository } from './departments.repository';
import { MembersModule } from '../members/members.module';
import { OrganizationDeletionRepository } from './organization-deletion.repository';
import { OrganizationDeletionService } from './organization-deletion.service';

@Module({
  imports: [DatabaseModule, MembersModule, PaymentCardsModule],
  controllers: [OrganizationsController, DepartmentsController, BillingScopeController],
  providers: [
    OrganizationBillingService,
    OrganizationsService,
    OrganizationDeletionRepository,
    OrganizationDeletionService,
    OrganizationsRepository,
    DepartmentsService,
    DepartmentsRepository,
  ],
})
export class OrganizationsModule {}
