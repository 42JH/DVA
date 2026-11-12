// handler 배열 하나로 모음 — 개발(browser.ts)과 테스트(node.ts)가 같은 가짜를 씀. 새 기능은 여기에 한 줄 추가
import { adminHandlers, authHandlers } from './auth'
import { callHandlers } from './calls'
import { companyHandlers } from './companies'
import { customerHandlers } from './customers'
import { dashboardHandlers, homeHandler } from './dashboard'
import { faqHandlers } from './faq'
import { orderHandlers } from './orders'
import { personaHandlers } from './personas'
import { scenarioTestHandlers } from './scenarioTests'

export const handlers = [
  ...authHandlers,
  ...adminHandlers,
  ...callHandlers,
  ...companyHandlers,
  ...customerHandlers,
  homeHandler,
  ...dashboardHandlers,
  ...faqHandlers,
  ...orderHandlers,
  ...personaHandlers,
  // 실제 시험 창구에 붙여 볼 때(VITE_SCENARIO_TEST=true)는 가짜 창구를 끔 — 그 요청은 개발 서버 프록시를 거쳐 실제 창구로 감
  ...(import.meta.env.VITE_SCENARIO_TEST === 'true' ? [] : scenarioTestHandlers),
]
