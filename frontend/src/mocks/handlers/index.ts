// handler 배열 하나로 모음 — 개발(browser.ts)과 테스트(node.ts)가 같은 가짜를 씀. 새 기능은 여기에 한 줄 추가
// (06 통화 상세 · 09 AI 미답변은 명세 전이라 MSW 대신 각 features/*/api 파일 안 메모리 가짜 — 10/30)
import { authHandlers } from './auth'
import { faqHandlers } from './faq'

export const handlers = [...authHandlers, ...faqHandlers]
