// handler 배열 하나로 모음 — 개발(browser.ts)과 테스트(node.ts)가 같은 가짜를 씀. 새 기능은 여기에 한 줄 추가
// (06 통화 상세 · 04 통화 내역 · 02 대시보드는 아직 features/*/api 파일 안 메모리 가짜 — 명세 반영 중, 11/01)
import { authHandlers } from './auth'
import { faqHandlers } from './faq'
import { homeHandlers } from './home'

export const handlers = [...authHandlers, ...faqHandlers, ...homeHandlers]
