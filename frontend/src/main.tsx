import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './shared/styles/global.css'

// 개발 중 VITE_USE_MOCK=true(.env.development 기본값) 면 MSW 가짜 API를 먼저 켬. 가짜가 없는 요청은 그대로 백엔드(프록시)로 감
async function enableMocking() {
  if (!import.meta.env.DEV || import.meta.env.VITE_USE_MOCK !== 'true') return
  const { worker } = await import('./mocks/browser')
  await worker.start({ onUnhandledFrame: 'bypass' })
}

// 가짜를 못 켜도(서비스 워커 등록 실패 등) 화면은 띄운다 — 그땐 요청이 실제 백엔드로 감
void enableMocking()
  .catch((e) => console.error('[MSW] 가짜 API를 켜지 못했습니다. 요청이 실제 백엔드로 갑니다.', e))
  .then(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  })
