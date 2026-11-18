"""최초 FAQ 목록 미리보기. --enqueue를 지정해야 로컬 영속 큐에 등록한다."""

import argparse
import asyncio
import os

from app.backend_api import BackendAPI
from app.config import ROOT, load_server_config
from app.rag.faq_bootstrap import initial_event
from app.rag.faq_events import FaqEventStore


async def execute(enqueue=False):
    cfg = load_server_config()
    backend = BackendAPI(os.environ['BACKEND_API_URL'], cfg.backend.timeout_sec)
    try:
        entries = await backend.initial_faq_entries()
    finally:
        await backend.close()
    event = initial_event(entries)
    print(f'전체 FAQ: {len(entries)}개')
    if event is None:
        print('FAQ가 없습니다. 큐에 등록하거나 기존 색인을 삭제하지 않습니다.')
        return
    print(f'FAQ 번호: {event.faq_ids}')
    print(f'초기 이전 eventId: {event.event_id}')
    if not enqueue:
        print('미리보기 완료. --enqueue를 지정하면 로컬 상태 DB의 큐에 등록합니다.')
        return
    f = cfg.faq_sync
    store = FaqEventStore(ROOT / f.db_path, max_pending=f.max_pending, busy_timeout_sec=f.busy_timeout_sec)
    added = await asyncio.to_thread(store.enqueue, event)
    print('영속 큐 등록 완료.' if added else '같은 초기 이전 알림이 이미 등록돼 있습니다.')
    print('검색 반영은 자동 소비자의 APPLIED 완료를 별도로 확인하세요.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--enqueue', action='store_true', help='현재 서버와 같은 로컬 상태 DB에 접수')
    args = parser.parse_args()
    asyncio.run(execute(args.enqueue))


if __name__ == '__main__':
    main()
