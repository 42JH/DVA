import { SetMetadata } from '@nestjs/common';

export const MVP_AI_ACCESS = 'auth:mvp-ai-order-intake';
// Match the current monolith: a service Bearer or administrator session is required.
// 개인 데이터는 각 업무에서 통화 범위를 검사하고, 디렉터리는 공유 대상으로 정한 활성 기업 사원의 기본 배송 정보만 조회한다.
export const MvpAiOrderAccess = () => SetMetadata('auth:mvp-ai-customer', true);
export const MvpAiPinAccess = () => SetMetadata('auth:mvp-ai-customer', true);
export const MvpAiDirectoryAccess = () => SetMetadata('auth:mvp-ai-customer', true);
// 일반 FAQ 원본 조회만 허용한다. 관리자 등록·수정 경로에는 적용하지 않는다.
export const MvpAiFaqAccess = () => SetMetadata('auth:mvp-ai-customer', true);
