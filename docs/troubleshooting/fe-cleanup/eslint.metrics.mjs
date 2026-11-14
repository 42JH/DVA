// 복잡도 재기 — 저장소의 ESLint 설정은 건드리지 않고 따로 둔 설정. frontend 폴더에서 실행 (아래 import 주소는 자기 저장소 위치로 바꿈)
import tseslint from 'file:///C:/Users/SSAFY/Desktop/S15P31D109/frontend/node_modules/typescript-eslint/dist/index.js'
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
