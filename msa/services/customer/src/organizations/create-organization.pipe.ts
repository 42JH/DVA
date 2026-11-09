import { PipeTransform } from '@nestjs/common';
import { ApiException, ErrorDetail } from '../common/errors/api.exception';
import { createValidationPipe } from '../common/http/validation.pipe';
import { CreateOrganizationDto } from './dto/create-organization.dto';

export class CreateOrganizationPipe implements PipeTransform<
  unknown,
  Promise<CreateOrganizationDto>
> {
  private readonly validation = createValidationPipe();

  async transform(value: unknown): Promise<CreateOrganizationDto> {
    let input: CreateOrganizationDto;
    try {
      input = (await this.validation.transform(value, {
        type: 'body',
        metatype: CreateOrganizationDto,
      })) as CreateOrganizationDto;
    } catch (error) {
      if (error instanceof ApiException)
        throw new ApiException(
          400,
          'INVALID_REQUEST',
          '기업 등록 입력값을 확인해 주세요.',
          (error.getResponse() as { details: ErrorDetail[] }).details.map((detail) => ({
            ...detail,
            field: detail.field.replace(/\.(\d+)(?=\.|$)/g, '[$1]'),
          })),
        );
      throw error;
    }
    const departmentNames = new Set<string>();
    for (const [index, department] of (input.departments ?? []).entries()) {
      if (departmentNames.has(department.name))
        throw new ApiException(400, 'INVALID_REQUEST', '같은 요청의 부서명은 중복될 수 없습니다.', [
          { field: `departments[${index}].name`, reason: 'DUPLICATE_ITEM' },
        ]);
      departmentNames.add(department.name);
    }
    const seen = { employeeNo: new Set<string>(), phoneNumber: new Set<string>() };
    for (const [index, member] of (input.members ?? []).entries()) {
      for (const field of ['employeeNo', 'phoneNumber'] as const) {
        if (seen[field].has(member[field]))
          throw new ApiException(
            400,
            'INVALID_REQUEST',
            '같은 요청의 사번·전화번호는 중복될 수 없습니다.',
            [{ field: `members[${index}].${field}`, reason: 'DUPLICATE_ITEM' }],
          );
        seen[field].add(member[field]);
      }
      if (member.departmentName != null && !departmentNames.has(member.departmentName))
        throw new ApiException(
          422,
          'VALIDATION_FAILED',
          '같은 요청에 등록할 부서명을 지정해 주세요.',
          [{ field: `members[${index}].departmentName`, reason: 'DEPARTMENT_NOT_FOUND' }],
        );
    }
    return input;
  }
}
