import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, IsString, Matches, ValidateIf, ValidateNested } from 'class-validator';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { MOBILE_PHONE_PATTERN } from '../../common/mobile-phone';
import { MembershipResponseDto } from '../../members/dto/member-response.dto';
import { OrganizationResponseDto } from '../../organizations/dto/organization-response.dto';
import { CustomerResponseDto } from './customer-response.dto';
import { CallIdentityDto } from '../../consultations/dto/call-identity.dto';
import { DepartmentDto } from '../../organizations/dto/department.dto';
import { CustomerPaymentMethod } from '../customers.types';

export class CallerContextRequestDto {
  @ApiProperty({
    description: '국내 표기로 정규화한 발신 휴대전화 번호. 선행 0을 보존한 숫자 문자열 11자리.',
    pattern: MOBILE_PHONE_PATTERN.source,
    example: '01012345678',
  })
  @IsString()
  @Matches(MOBILE_PHONE_PATTERN)
  phoneNumber!: string;

  @ApiPropertyOptional({
    type: () => CallIdentityDto,
    description:
      'AI가 실제 상담 업무 의도를 확인한 뒤 전달. 통화를 생성·재사용하고 callSessionSeq를 반환합니다. 최초 고객 확인은 call 없이 조회하며 통화를 저장하지 않습니다. providerCallId·incomingAt은 최초 수신 이벤트 값을 유지합니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => CallIdentityDto)
  call?: CallIdentityDto;
}

export class PinAddressDto {
  @ApiProperty() name!: string;
  @ApiProperty() phoneNumber!: string;
  @ApiProperty() roadAddress!: string;
  @ApiProperty() jibunAddress!: string;
  @ApiProperty({ type: String, nullable: true, required: false }) detailAddress?: string | null;
  @ApiProperty() dongName!: string;
  @ApiProperty() postalCode!: string;
}

export class PersonalContextPinDto {
  @ApiProperty({ minimum: 1 }) personalPinSeq!: number;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty({ type: PinAddressDto }) addressData!: PinAddressDto;
  @ApiProperty({ minimum: 1 }) version!: number;
}

export class CallerContextDto {
  @ApiProperty({ type: DepartmentDto, nullable: true }) department!: DepartmentDto | null;
  @ApiProperty({
    enum: ['billing', 'credit', 'groupBilling'],
    isArray: true,
    description:
      'billing 개인 카드, credit 월결제, groupBilling 부서 그룹결제. 자격이 있는 방식만 포함.',
  })
  availablePaymentMethods!: CustomerPaymentMethod[];
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    description:
      'call을 보낸 경우에만 반환하는 DB call_sessions.call_session_seq. 이후 주문 조회·취소·주소록 요청의 call_session_seq 헤더에 사용.',
  })
  callSessionSeq?: number;

  @ApiProperty({
    enum: ['REGISTERED', 'UNREGISTERED', 'WITHDRAWN'],
    description: '고객 등록 상태. 주문·주소록 유무로 판단하지 않습니다.',
  })
  lookupStatus!: 'REGISTERED' | 'UNREGISTERED' | 'WITHDRAWN';

  @ApiProperty({
    type: CustomerResponseDto,
    nullable: true,
    description:
      '현재 고객 정보. 기본 출발지는 이 이름·전화번호·address를 우선 사용하며 개인 PIN으로 덮어쓰지 않습니다.',
  })
  customer!: CustomerResponseDto | null;

  @ApiProperty({
    type: MembershipResponseDto,
    nullable: true,
    description: '활성 고객의 현재 소속. 비활성 소속도 상태를 확인할 수 있습니다.',
  })
  membership!: MembershipResponseDto | null;

  @ApiProperty({ type: OrganizationResponseDto, nullable: true })
  organization!: OrganizationResponseDto | null;

  @ApiProperty({
    enum: ['PERSONAL', 'COMPANY'],
    isArray: true,
    description: '현재 이용 가능한 범위. COMPANY는 고객·소속·기업이 모두 ACTIVE일 때만 포함.',
  })
  availableUsageTypes!: ('PERSONAL' | 'COMPANY')[];

  @ApiProperty({
    type: [PersonalContextPinDto],
    description: '본인의 개인 PIN 전체. 번호 오름차순.',
  })
  personalPins!: PersonalContextPinDto[];

  @ApiProperty({
    type: 'array',
    items: {},
    deprecated: true,
    description:
      '폐기된 기업 PIN 호환 필드. 항상 빈 배열이며 기업 공유 배송지는 GET /api/companies/search로 조회.',
  })
  companyPins!: never[];
}

export class CallerContextEnvelopeDto {
  @ApiProperty({ type: CallerContextDto }) data!: CallerContextDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
