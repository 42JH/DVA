import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { CallIdentityDto } from '../../consultations/dto/call-identity.dto';

export class OrderCallDto extends CallIdentityDto {
  @ApiProperty({
    description: '수신 이벤트의 발신번호. +82는 국내 0 표기로 정규화.',
    example: '+821012345678',
  })
  @IsString()
  @Matches(/^\+?[0-9]{3,20}$/)
  callerPhoneNumber!: string;
}
