import { PipeTransform } from '@nestjs/common';
import { createValidationPipe } from '../common/http/validation.pipe';
import { ApiException, ErrorDetail } from '../common/errors/api.exception';
import { CreateMemberDto, CreateMembersDto, InlineMemberDto } from './dto/member-request.dto';

export class CreateMemberPipe implements PipeTransform<
  unknown,
  Promise<Array<CreateMemberDto | InlineMemberDto>>
> {
  private readonly validation = createValidationPipe();

  async transform(value: unknown): Promise<Array<CreateMemberDto | InlineMemberDto>> {
    const input =
      value !== null && typeof value === 'object' && !Array.isArray(value) && 'items' in value
        ? value
        : { items: [value] };
    const batch = (await this.validation.transform(input, {
      type: 'body',
      metatype: CreateMembersDto,
    })) as CreateMembersDto;
    const items: Array<CreateMemberDto | InlineMemberDto> = [];
    const seen = {
      employeeNo: new Set<string>(),
      customerSeq: new Set<number>(),
      phoneNumber: new Set<string>(),
    };
    for (const [index, value] of batch.items.entries()) {
      const row = value as Record<string, unknown>;
      let item: CreateMemberDto | InlineMemberDto;
      try {
        item = (await this.validation.transform(row, {
          type: 'body',
          metatype: 'customerSeq' in row ? CreateMemberDto : InlineMemberDto,
        })) as CreateMemberDto | InlineMemberDto;
      } catch (error) {
        if (error instanceof ApiException)
          throw new ApiException(
            400,
            'INVALID_REQUEST',
            '직원 입력값을 확인해 주세요.',
            (error.getResponse() as { details: ErrorDetail[] }).details.map((detail) => ({
              ...detail,
              field: `items[${index}].${detail.field}`,
            })),
          );
        throw error;
      }
      const fields =
        'customerSeq' in item
          ? (['employeeNo', 'customerSeq'] as const)
          : (['employeeNo', 'phoneNumber'] as const);
      for (const field of fields) {
        const values = seen[field] as Set<string | number>;
        const key = item[field as keyof typeof item] as string | number;
        if (values.has(key))
          throw new ApiException(
            400,
            'INVALID_REQUEST',
            '같은 요청의 사번·고객·전화번호는 중복될 수 없습니다.',
            [{ field: `items[${index}].${field}`, reason: 'DUPLICATE_ITEM' }],
          );
        values.add(key);
      }
      items.push(item);
    }
    return items;
  }
}
