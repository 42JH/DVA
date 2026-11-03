"""로컬 Live-1 음성/RAG 웹 실험 서버. 마이크 연결은 사용자가 화면에서 시작한다."""

import os
from pathlib import Path


def main():
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent/'.env', override=False)
    if not all(os.getenv(key) for key in ('OPENAI_API_KEY', 'QDRANT_API_KEY', 'MONITOR_USER', 'MONITOR_PASSWORD')):
        raise SystemExit('OPENAI_API_KEY/QDRANT_API_KEY와 화면 인증 MONITOR_USER/MONITOR_PASSWORD가 필요합니다. 값은 출력하지 않습니다.')
    import uvicorn
    from openai import AsyncOpenAI
    from app.live_lab.app import create_lab_app
    from app.live_lab.config import load_lab_config
    from scripts.remote_text_search import create_search
    cfg = load_lab_config()
    app = create_lab_app(AsyncOpenAI(timeout=cfg.backend_timeout_seconds, max_retries=1),
                         lambda: create_search(cfg), cfg)
    print(f'웹 실험 화면: http://{cfg.host}:{cfg.port}/live-lab (브라우저에서 마이크 연결 시작)', flush=True)
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level='warning')


if __name__ == '__main__':
    main()
