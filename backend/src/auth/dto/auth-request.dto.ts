import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';
export class LoginDto {
  @ApiProperty({ pattern: '^[A-Za-z0-9]{1,20}$' })
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,20}$/)
  loginId!: string;
  @ApiProperty({ minLength: 6, format: 'password' })
  @IsString()
  @MinLength(6)
  password!: string;
}
export class SignupDto extends LoginDto {
  @ApiProperty()
  @IsString()
  @Matches(/\S/u)
  name!: string;
}
export class ResetPasswordDto {
  @ApiProperty({ minLength: 6, format: 'password' })
  @IsString()
  @MinLength(6)
  newPassword!: string;
}
export class ChangePasswordDto {
  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  currentPassword!: string;
  @ApiProperty({ minLength: 6, format: 'password' })
  @IsString()
  @MinLength(1)
  newPassword!: string;
  @ApiProperty({ format: 'password' })
  @IsString()
  @MinLength(1)
  newPasswordConfirm!: string;
}
