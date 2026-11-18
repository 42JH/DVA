"""실제 BE FAQ를 검증 전용 컬렉션에 색인해 검색만 평가한다. API 비용이 발생한다."""

import argparse
import asyncio
import json
import math
import os
from pathlib import Path
from statistics import fmean
from time import perf_counter

from app.backend_api import BackendAPI
from app.config import load_server_config
from app.rag.faq_bootstrap import initial_event
from app.rag.faq_events import FaqEventStore
from app.rag.faq_processor import FaqProcessor
from app.rag.faq_runtime import create_faq_runtime
from app.rag.service import RagService


class QueryOnlyEmbeddings:
    def __init__(self, inner):
        self.inner = inner

    def embed_documents(self, texts):
        raise RuntimeError('재사용 검증에서는 문서를 재임베딩할 수 없습니다.')

    def embed_query(self, text):
        return self.inner.embed_query(text)


async def evaluate(args):
    if not args.collection.startswith('manuals_validation_faq_'):
        raise ValueError('검증 전용 컬렉션 이름이 필요합니다.')
    args.directory.mkdir(parents=True, exist_ok=True)
    output = args.directory / 'report.json'
    if output.exists():
        raise ValueError('기존 실행 결과를 덮어쓰지 않습니다. 새 디렉터리를 지정하세요.')
    cfg = load_server_config()
    faq_cfg = cfg.faq_sync.model_copy(update={'collection':args.collection})
    backend = BackendAPI(os.environ['BACKEND_API_URL'], cfg.backend.timeout_sec)
    runtime = None
    report = {'status':'started', 'collection':args.collection, 'records':[],
              'scope':'BE 실제 원문, 검색/리랭킹만 평가. 답변 생성/Live 발화 평가 아님.',
              'search_descriptions':'현재 관리 FAQ BM25 전용 설정 사용. 원문 해시 일치 항목만 적용.'}
    def save():
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    try:
        entries = await backend.initial_faq_entries()
        if not entries:
            raise ValueError('실제 BE FAQ가 없습니다.')
        cases = json.loads(args.cases.read_text(encoding='utf-8'))
        titles = {'Q. '+entry.question for entry in entries}
        if len(titles) != len(entries) or any(not set(case['expected_faq_titles']) <= titles for case in cases):
            raise ValueError('평가 정답 제목과 BE FAQ가 일치하지 않습니다.')
        report['source'] = [entry.model_dump(by_alias=True) for entry in entries]
        state_directory = args.state_directory or args.directory
        if args.state_directory and not (state_directory/'events.sqlite3').is_file():
            raise ValueError('재사용할 기존 상태 DB가 없습니다.')
        events = FaqEventStore(state_directory/'events.sqlite3', max_pending=1000, busy_timeout_sec=.1)
        event = initial_event(entries)
        events.enqueue(event)
        started = perf_counter()
        runtime = await asyncio.to_thread(create_faq_runtime, events, faq_cfg, cfg.rag)
        if args.state_directory:
            current = {faq.source.faq_id:faq.source for faq in runtime.index.current().faqs}
            if current != {entry.faq_id:entry for entry in entries}:
                raise ValueError('기존 색인 원문과 현재 BE가 다릅니다. 재사용 평가를 중단합니다.')
            # 원래 객체의 메서드는 유지하고 색인 쓰기에 사용하는 객체만 감싼다.
            runtime.index.embeddings = QueryOnlyEmbeddings(runtime.index.embeddings)
            report['document_vectors_reused'] = True
        worker = FaqProcessor(events, backend, runtime.index, faq_cfg, cfg.rag)
        await worker.process_one()
        report['index_seconds'] = perf_counter()-started
        report['event'] = events.get(event.event_id)
        if report['event']['status'] != 'APPLIED':
            raise RuntimeError('초기 색인 미완료: '+str(report['event']['last_error']))
        report['faq_count'] = len(runtime.index.current().faqs)
        report['chunk_count'] = len(runtime.index.current().point_ids)
        service = RagService(cfg.rag, faq_index=runtime.index, reranker=runtime.reranker)
        for case in cases:
            expected = set(case['expected_faq_titles'])
            try:
                found = await service(case['question'])
                candidates = [row['title'] for row in found['rrf_candidates']]
                ranked = [row['title'] for row in found['reranked']]
                rank = next((i for i, title in enumerate(ranked, 1) if title in expected), None)
                record = {'id':case['id'], 'question':case['question'], 'expected':sorted(expected),
                          'candidate_hit5':int(bool(expected.intersection(candidates))),
                          'rerank_hit1':int(rank == 1), 'rerank_hit3':int(rank is not None and rank <= 3),
                          'reciprocal_rank':1/rank if rank else 0., **found}
            except Exception as error:
                record = {'id':case['id'], 'error_type':type(error).__name__,
                          'candidate_hit5':0, 'rerank_hit1':0, 'rerank_hit3':0, 'reciprocal_rank':0.}
            report['records'].append(record)
            save()
            print(f"{len(report['records'])}/{len(cases)}", flush=True)
        rows = report['records']
        report['summary'] = {key:fmean(row[key] for row in rows)
                             for key in ('candidate_hit5','rerank_hit1','rerank_hit3','reciprocal_rank')}
        report['summary']['errors'] = sum('error_type' in row for row in rows)
        report['summary']['timings'] = {}
        for key in ('embedding_seconds','dense_search_seconds','tokenization_and_bm25_seconds','reranking_seconds','retrieval_seconds'):
            times = sorted(row['timings'][key] for row in rows if key in row.get('timings', {}))
            if times:
                report['summary']['timings'][key] = {'mean':fmean(times), 'p95':times[math.ceil(.95*len(times))-1]}
        report['status'] = 'completed' if not report['summary']['errors'] else 'completed_with_errors'
        print(json.dumps(report['summary'], ensure_ascii=False), flush=True)
    except BaseException as error:
        report['status'], report['error_type'] = 'failed', type(error).__name__
        raise
    finally:
        save()
        if runtime is not None:
            await asyncio.to_thread(runtime.close)
        await backend.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--collection', required=True)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--cases', type=Path, required=True)
    parser.add_argument('--state-directory', type=Path, help='기존 상태 DB/벡터를 그대로 재사용. BE 원문이 다르면 실패')
    asyncio.run(evaluate(parser.parse_args()))


if __name__ == '__main__':
    main()
