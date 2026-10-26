import { setupWorker } from 'msw/browser'
import { authHandlers } from './handlers/auth'
import { faqHandlers } from './handlers/faq'

// 기능을 만들 때 handlers/<기능>.ts 를 추가하고 여기 넣는다. 가짜가 없는 요청은 그대로 백엔드로 감 (main.tsx)
export const worker = setupWorker(...authHandlers, ...faqHandlers)
