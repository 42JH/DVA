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
        '/api': { target: env.DEV_PROXY_TARGET, changeOrigin: true },
      },
    },
  }
})
