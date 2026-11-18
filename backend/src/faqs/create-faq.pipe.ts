import { PipeTransform } from '@nestjs/common';
import { createValidationPipe } from '../common/http/validation.pipe';
import { CreateFaqDto, CreateFaqsDto } from './dto/faq-request.dto';

export class CreateFaqPipe implements PipeTransform<unknown, Promise<CreateFaqDto[]>> {
  private readonly validation = createValidationPipe();

  async transform(value: unknown): Promise<CreateFaqDto[]> {
    const result: CreateFaqsDto = await this.validation.transform(value, {
      type: 'body',
      metatype: CreateFaqsDto,
    });
    return result.items;
  }
}
