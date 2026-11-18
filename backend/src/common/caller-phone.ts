// 한국 국제 표기만 국내 표기로 통일한다. 다른 국가 번호는 임의로 바꾸지 않는다.
export function callerPhone(value: string): string {
  return value.replace(/^(?:\+82|0082)/, '0');
}
