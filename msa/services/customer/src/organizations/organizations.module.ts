import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationsRepository } from './organizations.repository';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { DepartmentsRepository } from './departments.repository';

@Module({
  imports: [DatabaseModule],
  controllers: [OrganizationsController, DepartmentsController],
  providers: [
    OrganizationsService,
    OrganizationsRepository,
    DepartmentsService,
    DepartmentsRepository,
  ],
})
export class OrganizationsModule {}
