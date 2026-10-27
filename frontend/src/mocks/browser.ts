import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'

// 개발 서버용 가짜 API (main.tsx가 VITE_USE_MOCK=true일 때 켬)
export const worker = setupWorker(...handlers)
