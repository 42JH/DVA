import { SetMetadata } from '@nestjs/common';

export const MVP_AI_ACCESS = 'auth:mvp-ai-order-intake';
// shortcut: 서비스 인증은 Jira 135에서 추가한다. 통화 범위를 검사하는 메서드에만 적용한다.
export const MvpAiOrderAccess = () => SetMetadata(MVP_AI_ACCESS, true);
export const MvpAiPinAccess = () => SetMetadata(MVP_AI_ACCESS, true);
