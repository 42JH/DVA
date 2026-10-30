import { PipeTransform } from '@nestjs/common';
import { createValidationPipe } from '../common/http/validation.pipe';
import { CreateFaqDto, CreateFaqsDto } from './dto/faq-request.dto';

export class CreateFaqPipe implements PipeTransform<unknown, Promise<CreateFaqDto[]>> {
  private readonly validation = createValidationPipe();

  async transform(value: unknown): Promise<CreateFaqDto[]> {
    // 기존 단건 본문도 같은 배열 검증과 트랜잭션을 사용한다.
    const input =
      value !== null && typeof value === 'object' && !Array.isArray(value) && 'items' in value
        ? value
        : { items: [value] };
    const result: CreateFaqsDto = await this.validation.transform(input, {
      type: 'body',
      metatype: CreateFaqsDto,
    });
    return result.items;
  }
}
