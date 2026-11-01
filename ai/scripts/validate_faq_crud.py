"""검증 전용 색인의 수신 API→소비자→실제 임베딩/Qdrant/리랭킹 통합 점검.

BE 원문 응답만 통제된 HTTP 모의 전송을 사용한다. 운영 관리자 API/FAQ는 수정하지 않는다.
"""
import argparse
import asyncio
import json
import os
import secrets
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace
from uuid import uuid4

import httpx2
from fastapi import FastAPI

from app.backend_api import BackendAPI
from app.config import load_server_config
from app.rag.faq_events import FaqEventStore
from app.rag.faq_processor import FaqProcessor
from app.rag.faq_runtime import create_faq_runtime
from app.rag.service import RagService
from app.webhooks.faqs import router


async def run(directory, collection):
    if not collection.startswith('manuals_validation_crud_'):
        raise ValueError('CRUD 검증 전용 컬렉션이 필요합니다.')
    directory.mkdir(parents=True, exist_ok=True)
    output = directory/'report.json'
    if output.exists():
        raise ValueError('기존 검증 결과를 덮어쓰지 않습니다.')
    report = {'status':'running', 'collection':collection, 'checks':[],
              'scope':'BE 조회만 모의 HTTP. 수신 API/큐/임베딩/Qdrant/GPU/검색은 실제 코드와 서비스.'}
    cfg = load_server_config()
    sync = cfg.faq_sync.model_copy(update={'collection':collection})
    events = FaqEventStore(directory/'events.sqlite3', max_pending=1000, busy_timeout_sec=.1)
    source, reads, unavailable = {}, [], False
    def respond(request):
        reads.append(str(request.url.path))
        if unavailable:
            return httpx2.Response(503)
        ids = [int(i) for i in request.url.params['faqEntrySeqs'].split(',')]
        rows = [source[i] for i in sorted(ids) if i in source]
        return httpx2.Response(200, json={'data':rows, 'hasNext':False, 'total_count':len(rows)})
    backend = BackendAPI('https://controlled-source.test', 5, transport=httpx2.MockTransport(respond))
    runtime = None
    original_token = os.environ.get('AI_FAQ_TOKEN')
    token = secrets.token_hex(32)
    os.environ['AI_FAQ_TOKEN'] = token
    def check(name, condition, **details):
        if not condition:
            raise AssertionError(name)
        report['checks'].append({'name':name, **details})
    def entry(number, answer):
        return {'faqEntrySeq':number, 'question':f'통합검증 {number} 택배 보관함 이용 규칙은 무엇인가요?',
                'answer':answer,'updatedAt':'2026-10-31T00:00:00Z'}
    try:
        runtime = await asyncio.to_thread(create_faq_runtime, events, sync, cfg.rag)
        check('전용 빈 색인',not runtime.index.current().faqs)
        now = [100.]
        worker = FaqProcessor(events, backend, runtime.index, sync, cfg.rag, clock=lambda:now[0])
        app = FastAPI()
        app.include_router(router)
        app.state.svc = SimpleNamespace(cfg=cfg, faq_events=events, faq_processor=worker)
        async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url='http://validation') as http:
            async def notify(operation, ids, event_id=None):
                event_id = event_id or str(uuid4())
                started = perf_counter()
                response = await http.post('/internal/faqs/refresh', headers={'Authorization':'Bearer '+token},
                    json={'eventId':event_id,'operation':operation,'faqEntrySeqs':ids})
                check(operation+' HTTP202/영속 저장',response.status_code==202 and events.get(event_id) is not None,
                      seconds=perf_counter()-started, event_id=event_id)
                return event_id
            async def apply(event_id):
                started = perf_counter()
                await worker.process_one()
                check('APPLIED', events.get(event_id)['status']=='APPLIED',seconds=perf_counter()-started)
            source[2000000001] = entry(2000000001,'검증용 보관함은 오전 열 시부터 오후 네 시까지 이용합니다.')
            source[2000000002] = entry(2000000002,'검증용 보관함에 음식물은 넣을 수 없습니다.')
            insert = await notify('INSERT',list(source))
            check('202는 반영 전',events.get(insert)['status']=='QUEUED' and not runtime.index.current().faqs)
            await apply(insert)
            service = RagService(cfg.rag, faq_index=runtime.index, reranker=runtime.reranker)
            found = await service(source[2000000001]['question'])
            check('복수 추가 검색 반영',len(runtime.index.current().faqs)==2 and any(
                '오전 열 시' in row['content'] for row in found['context']['evidence']))
            old_snapshot = runtime.index.current()
            before_count = runtime.client.count(collection,exact=True).count
            await notify('INSERT',list(source),insert)
            check('동일 알림 중복 실행 없음',not await worker.process_one() and runtime.client.count(collection,exact=True).count==before_count)
            source[2000000001] = entry(2000000001,'검증용 보관함은 오후 여섯 시까지 이용합니다.')
            update = await notify('UPDATE',[2000000001])
            unavailable = True
            await worker.process_one()
            check('조회 실패는 삭제 아님',events.get(update)['status']=='RETRY' and len(runtime.index.current().faqs)==2)
            unavailable = False
            now[0] = events.get(update)['retry_at']
            await apply(update)
            changed = await service(source[2000000001]['question'])
            content = '\n'.join(row['content'] for row in changed['context']['evidence'])
            check('수정 검색 반영/옛 본문 제외','오후 여섯 시' in content and '오전 열 시' not in content)
            count_before_delete = len(reads)
            source.clear()
            delete = await notify('DELETE',[2000000001,2000000002])
            check('물리 삭제 전 최종 반환 차단',not runtime.index.filter_rows([
                {'source':'backend-faq:2000000001'}]))
            await apply(delete)
            check('DELETE 원문 조회 생략',len(reads)==count_before_delete)
            check('모든 버전 실제 벡터 삭제',runtime.client.count(collection,exact=True).count==0)
            check('활성 판본/검색 근거 제거',not runtime.index.current().faqs and
                  (await service('보관함 이용 규칙'))['context']['status']=='no_evidence')
            check('옛 검색 판본도 삭제 제외',not old_snapshot.search.search('보관함')['results'])
            with events.connect() as db:
                check('원문/벡터 캐시 정리',db.execute('SELECT count(*) FROM faq_active_sources').fetchone()[0]==0 and
                      db.execute('SELECT count(*) FROM faq_embedding_cache').fetchone()[0]==0)
        report['status'] = 'completed'
    except BaseException as error:
        report['status'], report['error_type'] = 'failed', type(error).__name__
        raise
    finally:
        output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        if runtime is not None:
            await asyncio.to_thread(runtime.close)
        await backend.close()
        if original_token is None:
            os.environ.pop('AI_FAQ_TOKEN',None)
        else:
            os.environ['AI_FAQ_TOKEN'] = original_token
    print(json.dumps(report,ensure_ascii=False,indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',type=Path,required=True)
    parser.add_argument('--collection',required=True)
    args = parser.parse_args()
    asyncio.run(run(args.directory,args.collection))


if __name__ == '__main__':
    main()
