import fs from 'node:fs'
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { importX } from 'eslint-plugin-import-x'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier/flat'
import { defineConfig, globalIgnores } from 'eslint/config'

// 팀 컨벤션 v4 (노션) 5장 — 구조 규칙을 이 파일이 검사한다
// 기능 폴더는 자동으로 읽는다. 새 기능을 만들어도 이 파일은 고치지 않는다
const features = fs
  .readdirSync('src/features', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

export default defineConfig([
  globalIgnores(['dist', 'public/mockServiceWorker.js']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: { 'import-x': importX },
    settings: { 'import-x/resolver-next': [createTypeScriptImportResolver()] },
    languageOptions: { globals: globals.browser },
    rules: {
      // 4.2 의존은 한 방향 shared → features → app, 기능 폴더끼리 import 금지
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            ...features.map((f) => ({
              target: `./src/features/${f}`,
              from: './src/features',
              except: [`./${f}`],
              message: '기능 폴더끼리는 import하지 않는다. 같이 쓰는 코드는 shared/로 올린다.',
            })),
            { target: './src/features', from: './src/app', message: 'features는 app을 import하지 않는다.' },
            {
              target: './src/shared',
              from: ['./src/features', './src/app'],
              message: 'shared는 features · app을 import하지 않는다.',
            },
          ],
        },
      ],
      // 9 · 타입 import 표기 통일 (tsconfig verbatimModuleSyntax와 함께)
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // 4.3 components는 서버 데이터를 hooks를 통해서만 (타입 import는 허용)
  {
    files: ['src/features/*/components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/api/*',
                '@/features/*/api/*',
                '@/shared/api/*',
                '@/shared/auth/sessionApi',
                '@/shared/order/orderApi',
              ],
              allowTypeImports: true,
              message: 'components는 hooks를 통해서만 서버 데이터를 쓴다.',
            },
            {
              group: ['@tanstack/react-query'],
              allowTypeImports: true,
              message: 'React Query는 hooks에서만 쓴다.',
            },
          ],
        },
      ],
    },
  },
  // 4.3 api는 React를 모른다 (queryOptions는 React가 아니라 허용)
  {
    files: [
      'src/features/*/api/**/*.ts',
      'src/shared/api/**/*.ts',
      'src/shared/auth/sessionApi.ts',
      'src/shared/order/orderApi.ts',
    ],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'react', message: 'api는 React를 import하지 않는다.' },
            { name: 'react-dom', message: 'api는 React를 import하지 않는다.' },
            { name: 'react-router', message: 'api는 화면 이동을 모른다.' },
          ],
          patterns: [
            { group: ['**/hooks/*', '**/components/*'], message: 'api는 hooks · components를 부르지 않는다.' },
          ],
        },
      ],
    },
  },
  prettier,
])
