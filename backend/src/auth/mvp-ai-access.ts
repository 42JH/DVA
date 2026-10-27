import { SetMetadata } from '@nestjs/common';

export const MVP_AI_ACCESS = 'auth:mvp-ai-order-intake';
// shortcut: 서비스 인증은 Jira 135에서 추가한다. 55번의 AI 수신 메서드에만 적용한다.
export const MvpAiOrderIntake = () => SetMetadata(MVP_AI_ACCESS, true);
