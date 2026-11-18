// 실행: npx tsx --tsconfig tsconfig.app.json src/features/company/fitNames.test.ts
import assert from 'node:assert/strict'
import { fitNames } from './fitNames'

const w = (s: string) => s.length * 10 // 글자당 10px로 단순화
const names = ['한태원', '김지우', '이재훈', '박서연']
assert.equal(fitNames(names, 1000, w), '한태원, 김지우, 이재훈, 박서연') // 다 들어감
assert.equal(fitNames(names, 160, w), '한태원, 김지우 외 2명') // 넘치면 들어가는 만큼 + 외 n명
assert.equal(fitNames(names, 10, w), '한태원 외 3명') // 아무것도 안 들어가도 첫 이름은 보임
assert.equal(fitNames(['한태원'], 10, w), '한태원') // 한 명은 그대로
assert.equal(fitNames([], 100, w), '')
