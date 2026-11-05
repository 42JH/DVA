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
  imports: [DatabaseModule, MembersModule],
  controllers: [OrganizationsController, DepartmentsController],
  providers: [
    OrganizationsService,
    OrganizationDeletionRepository,
    OrganizationDeletionService,
    OrganizationsRepository,
    DepartmentsService,
    DepartmentsRepository,
  ],
})
export class OrganizationsModule {}
