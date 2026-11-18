// handler 배열 하나로 모음 — 개발(browser.ts)과 테스트(node.ts)가 같은 가짜를 씀. 새 기능은 여기에 한 줄 추가
import { http, HttpResponse, passthrough } from 'msw'
import { API_BASE_URL } from '@/shared/api/client'
import { adminHandlers, authHandlers } from './auth'
import { callHandlers } from './calls'
import { companyHandlers } from './companies'
import { customerHandlers } from './customers'
import { dashboardHandlers, homeHandler } from './dashboard'
import { faqHandlers } from './faq'
import { orderHandlers } from './orders'
import { personaHandlers } from './personas'
import { scenarioTestHandlers } from './scenarioTests'

// 가짜 응답이 없는 저장 요청(POST · PATCH · PUT · DELETE)은 실제 백엔드로 넘기지 않고 여기서 501 — 가짜 모드에서 누른 것이 실서버에 닿지 않게
// (넘어가면 로그인이 없어 401이 나고 화면이 로그인으로 튕김). 읽기(GET)는 전처럼 그대로 넘김
const noMock = http.all(`${API_BASE_URL}/*`, ({ request }) =>
  request.method === 'GET'
    ? passthrough()
    : HttpResponse.json(
        { error: { code: 'MOCK_NOT_IMPLEMENTED', message: '가짜 서버에 없는 요청입니다.' } },
        { status: 501 },
      ),
)

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
  ...scenarioTestHandlers,
  noMock, // 맨 끝 — 위에서 아무도 안 받은 요청만
]
