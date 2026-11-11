import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';

function DeleteIds() {
  return applyDecorators(
    ApiProperty({
      type: [Number],
      minItems: 1,
      maxItems: 100,
      description: '삭제 대상 번호. 단건도 배열로 전달하며 중복은 허용하지 않습니다.',
    }),
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(100),
    ArrayUnique(),
    IsInt({ each: true }),
    Min(1, { each: true }),
    Max(2147483647, { each: true }),
  );
}

export class DeleteAdminsDto {
  @DeleteIds() adminUserSeqs!: number[];
}
export class DeleteCallsDto {
  @DeleteIds() callSessionSeqs!: number[];
}
export class DeleteOrdersDto {
  @DeleteIds() orderSeqs!: number[];
}
export class DeleteDraftsDto {
  @DeleteIds() draftSeqs!: number[];
}
export class DeleteMembersDto {
  @DeleteIds() membershipSeqs!: number[];
}
export class DeleteDepartmentsDto {
  @DeleteIds() departmentSeqs!: number[];
}
export class DeleteQuestionsDto {
  @DeleteIds() unansweredQuestionSeqs!: number[];
}
export class DeleteCustomerCardsDto {
  @DeleteIds() customerSeqs!: number[];
}
export class DeleteCompanyCardsDto {
  @DeleteIds() organizationSeqs!: number[];
}
