// handler 배열 하나로 모음 — 개발(browser.ts)과 테스트(node.ts)가 같은 가짜를 씀. 새 기능은 여기에 한 줄 추가
import { authHandlers } from './auth'
import { callHandlers } from './call'
import { faqHandlers } from './faq'

export const handlers = [...authHandlers, ...callHandlers, ...faqHandlers]
