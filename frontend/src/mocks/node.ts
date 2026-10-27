import { setupServer } from 'msw/node'
import { handlers } from './handlers'

// 테스트(Vitest)용 가짜 API — 개발과 같은 handler. [MVP 후] test/setup.ts에서 listen · resetHandlers · close
export const server = setupServer(...handlers)
