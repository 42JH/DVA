import { SetMetadata } from '@nestjs/common';

export const MVP_AI_ACCESS = 'auth:mvp-ai-order-intake';
// shortcut: 서비스 인증은 Jira 135에서 추가한다. 허용한 메서드에만 명시적으로 적용한다.
// 개인 데이터는 각 업무에서 통화 범위를 검사하고, 디렉터리는 공식 공개 PIN만 조회한다.
export const MvpAiOrderAccess = () => SetMetadata(MVP_AI_ACCESS, true);
export const MvpAiPinAccess = () => SetMetadata(MVP_AI_ACCESS, true);
export const MvpAiDirectoryAccess = () => SetMetadata(MVP_AI_ACCESS, true);
