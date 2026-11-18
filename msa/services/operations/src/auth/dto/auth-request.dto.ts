import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength, MaxLength } from 'class-validator';
export class LoginDto {
  @ApiProperty({
    description: '로그인 ID. 영문·숫자 1~20자, 대소문자 구분.',
    example: 'operator01',
    pattern: '^[A-Za-z0-9]{1,20}$',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,20}$/)
  loginId!: string;
  @ApiProperty({ description: '비밀번호. 최소 6자.', minLength: 6, format: 'password' })
  @IsString()
  @MinLength(6)
  password!: string;
}
export class SignupDto extends LoginDto {
  @ApiProperty({
    description: '비밀번호. 6~256자. 공백·유니코드 허용.',
    minLength: 6,
    maxLength: 256,
    format: 'password',
  })
  @IsString()
  @MinLength(6)
  @MaxLength(256)
  declare password: string;
  @ApiProperty({
    description: '관리자 이름. 공백만 입력할 수 없습니다. 최대 50자.',
    example: '홍길동',
    maxLength: 50,
  })
  @IsString()
  @Matches(/\S/u)
  @MaxLength(50)
  name!: string;
}
export class ChangePasswordDto {
  @ApiProperty({ description: '현재 비밀번호.', format: 'password' })
  @IsString()
  @MinLength(1)
  currentPassword!: string;
  @ApiProperty({
    description: '새 비밀번호. 6~256자.',
    minLength: 6,
    maxLength: 256,
    format: 'password',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  newPassword!: string;
  @ApiProperty({
    description: '새 비밀번호 확인. newPassword와 일치해야 합니다.',
    format: 'password',
    maxLength: 256,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  newPasswordConfirm!: string;
}
