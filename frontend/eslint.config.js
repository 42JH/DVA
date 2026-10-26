import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier/flat'
import { defineConfig, globalIgnores } from 'eslint/config'

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
    languageOptions: {
      globals: globals.browser,
    },
  },
  // MVVM 경계 (README '구조'): View → ViewModel → Model 한 방향으로만 부른다
  {
    files: ['src/features/*/view/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/model', '**/model/*'],
              message: 'View는 Model을 직접 부르지 않습니다. ViewModel 훅을 쓰세요.',
            },
            {
              group: ['**/shared/api/*'],
              message: 'View에서 API를 직접 부르지 않습니다. ViewModel을 거치세요.',
            },
            {
              group: ['@tanstack/react-query'],
              message: '서버 데이터는 ViewModel 훅에서만 다룹니다.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/features/*/model/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'react-router', '@tanstack/react-query'],
              message: 'Model은 React · 화면을 모릅니다 (데이터 · API만).',
            },
            {
              group: ['**/view', '**/view/*', '**/viewmodel', '**/viewmodel/*'],
              message: 'Model은 View · ViewModel을 부르지 않습니다.',
            },
          ],
        },
      ],
    },
  },
  prettier,
])
