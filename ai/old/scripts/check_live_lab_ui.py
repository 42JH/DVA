"""로컬 웹 화면을 브라우저에서 검사한다. Live 세션·마이크·유료 API는 시작하지 않는다."""

import asyncio
import os
from pathlib import Path


async def run():
    from dotenv import load_dotenv
    from playwright.async_api import async_playwright
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root/'.env', override=False)
    from app.live_lab.config import load_lab_config
    cfg = load_lab_config()
    output = root/'data/private/live-lab'
    output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(http_credentials={'username': os.environ['MONITOR_USER'],
                                                              'password': os.environ['MONITOR_PASSWORD']},
                                            viewport={'width': 1440, 'height': 1080})
        page = await context.new_page()
        failures = []
        page.on('pageerror', lambda error: failures.append(type(error).__name__))
        response = await page.goto(f'http://{cfg.host}:{cfg.port}/live-lab', wait_until='networkidle')
        assert response.status == 200
        assert await page.locator('#connect').is_enabled()
        assert await page.locator('#stop').is_disabled()
        assert await page.locator('#models').inner_text() == f'{cfg.live_model} / {cfg.backend_model}'
        await page.screenshot(path=str(output/'desktop.png'), full_page=True)
        await page.set_viewport_size({'width': 390, 'height': 844})
        await page.screenshot(path=str(output/'mobile.png'), full_page=True)
        assert await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        assert failures == []
        await browser.close()
    print('브라우저 초기 화면: 데스크톱/모바일, 스크립트 오류 없음, 가로 넘침 없음. 실제 음성 연결 없음.')


if __name__ == '__main__':
    asyncio.run(run())
