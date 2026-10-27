import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';
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
  @ApiProperty({ description: '관리자 이름. 공백만 입력할 수 없습니다.', example: '홍길동' })
  @IsString()
  @Matches(/\S/u)
  name!: string;
}
export class ResetPasswordDto {
  @ApiProperty({ description: '초기화할 새 비밀번호. 최소 6자.', minLength: 6, format: 'password' })
  @IsString()
  @MinLength(6)
  newPassword!: string;
}
export class ChangePasswordDto {
  @ApiProperty({ description: '현재 비밀번호.', format: 'password' })
  @IsString()
  @MinLength(1)
  currentPassword!: string;
  @ApiProperty({ description: '새 비밀번호. 최소 6자.', minLength: 6, format: 'password' })
  @IsString()
  @MinLength(1)
  newPassword!: string;
  @ApiProperty({
    description: '새 비밀번호 확인. newPassword와 일치해야 합니다.',
    format: 'password',
  })
  @IsString()
  @MinLength(1)
  newPasswordConfirm!: string;
}
