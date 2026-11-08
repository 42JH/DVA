// handler 배열 하나로 모음 — 개발(browser.ts)과 테스트(node.ts)가 같은 가짜를 씀. 새 기능은 여기에 한 줄 추가
import { adminHandlers, authHandlers } from './auth'
import { callHandlers } from './calls'
import { companyHandlers } from './companies'
import { customerHandlers } from './customers'
import { dashboardHandlers } from './dashboard'
import { faqHandlers } from './faq'
import { orderHandlers } from './orders'
import { personaHandlers } from './personas'

export const handlers = [
  ...authHandlers,
  ...adminHandlers,
  ...callHandlers,
  ...companyHandlers,
  ...customerHandlers,
  ...dashboardHandlers,
  ...faqHandlers,
  ...orderHandlers,
  ...personaHandlers,
]
