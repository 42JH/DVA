import { SetMetadata } from '@nestjs/common';

export const MVP_AI_ACCESS = 'auth:mvp-ai-order-intake';
// shortcut: 서비스 인증은 Jira 135에서 추가한다. 허용한 메서드에만 명시적으로 적용한다.
// 개인 데이터는 각 업무에서 통화 범위를 검사한다. 배송지 검색은 별도 AI 업무 토큰으로 인증한다.
export const MvpAiOrderAccess = () => SetMetadata(MVP_AI_ACCESS, true);
export const MvpAiPinAccess = () => SetMetadata(MVP_AI_ACCESS, true);
// 일반 FAQ 원본 조회만 허용한다. 관리자 등록·수정 경로에는 적용하지 않는다.
export const MvpAiFaqAccess = () => SetMetadata(MVP_AI_ACCESS, true);
