import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // VITE_ 접두사 없는 값도 읽음(세 번째 인자 '') — DEV_PROXY_TARGET은 개발 서버만 쓰고 브라우저 코드엔 안 들어감
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }, // 컨벤션 5: '@/'는 src
    server: {
      proxy: {
        // /api 그대로 백엔드로 (BE 안내 10/31: 쿠키 SameSite=Lax라 같은 origin인 프록시로 붙음). 주소는 .env.development
        // 실서버는 허용한 Origin에서 온 저장 · 수정 · 삭제만 받음(CORS_ORIGINS) → 같은 도메인에 배포한 것처럼 Origin을 대상 주소로 바꿔 보냄
        '/api': {
          target: env.DEV_PROXY_TARGET,
          changeOrigin: true,
          configure: (proxy) =>
            proxy.on('proxyReq', (req) => {
              if (req.getHeader('origin'))
                req.setHeader('origin', new URL(env.DEV_PROXY_TARGET).origin)
            }),
        },
      },
    },
  }
})
