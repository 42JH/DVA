import { Injectable } from '@nestjs/common';
import { DashboardRepository } from './dashboard.repository';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

@Injectable()
export class DashboardService {
  constructor(private readonly repository: DashboardRepository) {}
  stageDropoffs(query: DashboardQueryDto) {
    return this.repository.stageDropoffs(query.customerType);
  }
  registrationTime(query: DashboardQueryDto) {
    return this.repository.registrationTime(query.customerType);
  }
  complaintCalls(query: DashboardQueryDto) {
    return this.repository.complaintCalls(query.customerType);
  }
  responseWait(query: DashboardQueryDto) {
    return this.repository.responseWait(query.customerType);
  }
}
