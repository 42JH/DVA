// 복잡도 재기 — 저장소의 ESLint 설정은 건드리지 않고 따로 둔 설정. frontend 폴더에서 실행 (typescript-eslint는 그 폴더의 node_modules에서 찾음)
import { createRequire } from 'node:module'
const tseslint = createRequire(`${process.cwd()}/package.json`)('typescript-eslint')
export default [
  { ignores: ['dist/**', 'public/**', 'src/mocks/**', '**/*.test.ts', 'node_modules/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
      'max-lines-per-function': ['warn', { max: 120, skipBlankLines: true, skipComments: true }],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'no-nested-ternary': 'warn',
      'max-params': ['warn', 4],
    },
  },
]
