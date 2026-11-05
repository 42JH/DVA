import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { CustomersRepository } from './customers.repository';
import { ListCustomersQueryDto } from './dto/customer-request.dto';

@Injectable()
export class CustomersService {
  constructor(private readonly repository: CustomersRepository) {}
  list(query: ListCustomersQueryDto) {
    return this.repository.list(query).then((rows) => new ListResponse(rows, query.limit));
  }
  async find(id: number, administrator: boolean) {
    const customer = await this.repository.find(id);
    if (!customer || (!administrator && customer.status === 'WITHDRAWN'))
      throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
    return customer;
  }
}
