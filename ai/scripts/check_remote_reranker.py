"""배포 점검: 공개 FAQ 후보로 외부 GPU만 호출. OpenAI/PBX/DB 호출 없음."""
import argparse
import concurrent.futures
import json
import math
import os
import statistics
import time
from pathlib import Path
from types import SimpleNamespace

import httpx2 as httpx
from app.config import ROOT
from app.rag.algorithms import faq_documents
from app.rag.remote import RemoteReranker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'data/private/gcp/reranker-check.json')
    args = parser.parse_args()
    url, key = os.environ['RAG_RERANKER_URL'], os.environ['RAG_RERANKER_API_KEY']
    documents = faq_documents((ROOT/'manuals/delivery_faq.md').read_text(encoding='utf-8'), ROOT/'manuals/delivery_faq.md')
    titles = ['Q. 어느 택배사로 가나요?', 'Q. 착불도 되나요?', 'Q. 요금은 얼마인가요?',
              'Q. 배송은 얼마나 걸리나요?', 'Q. 수거는 언제 오나요?']
    by_title = {doc.metadata['header_3']: doc for doc in documents}
    candidates = [{'chunk_id': by_title[t].metadata['chunk_id'], 'title': t, 'context': by_title[t].page_content} for t in titles]
    question = '택배를 착불로 보낼 수 있나요?'
    results = []
    with httpx.Client(timeout=30) as client:
        health = client.get(url+'/health')
        health.raise_for_status()
        denied = client.post(url+'/rerank', json={'question': question, 'documents': [
            {'chunk_id': d['chunk_id'], 'content': d['context']} for d in candidates]})
        if denied.status_code != 401:
            raise RuntimeError('인증 없는 요청이 401로 거절되지 않았습니다.')
        validate_body = {'documents':[{'chunk_id':'registration-check', 'content':'고객이 직접 포장해 주세요.'}]}
        validate_denied = client.post(url+'/validate-documents', json=validate_body)
        if validate_denied.status_code != 401:
            raise RuntimeError('인증 없는 등록 길이 검증이 거절되지 않았습니다.')
        too_long = client.post(url+'/validate-documents',
            headers={'Authorization':'Bearer '+key}, json={'documents':[
                {'chunk_id':'overlong-check', 'content':'가'*4000}]})
        if too_long.status_code != 422:
            raise RuntimeError('긴 원문이 등록 전에 거절되지 않았습니다.')
    reranker = RemoteReranker(url, key, 30)
    try:
        reranker.validate_chunks((SimpleNamespace(point_id='registration-check', content='고객이 직접 포장해 주세요.'),))
        def one(kind, index):
            started = time.monotonic()
            ranked = reranker.rerank(question, candidates)
            return {'kind': kind, 'index': index, 'seconds': time.monotonic()-started,
                    'top1': ranked[0]['title'], 'candidate_count': len(ranked)}
        results.append(one('first', 0))
        for index in range(5):
            results.append(one('warm', index))
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            results.extend(executor.map(lambda i: one('concurrent3', i), range(3)))
    finally:
        reranker.close()
    if any(row['top1'] != 'Q. 착불도 되나요?' or row['candidate_count'] != 5 for row in results):
        raise RuntimeError('고정 점검 질문의 순위/후보 수를 확인하세요.')
    summary = {}
    for kind in ('first', 'warm', 'concurrent3'):
        times = sorted(row['seconds'] for row in results if row['kind'] == kind)
        summary[kind] = {'count': len(times), 'mean_seconds': statistics.fmean(times),
                         'p95_seconds': times[math.ceil(len(times)*.95)-1]}
    report = {'health': health.json(), 'unauthenticated_status': denied.status_code,
              'registration_unauthenticated_status': validate_denied.status_code,
              'registration_overlong_status': too_long.status_code, 'registration_validated': True,
              'question': question, 'records': results, 'summary': summary,
              'note': '외부 왕복 포함 표본9개 점검. 전체 FAQ 정확도/통화 용량/정답 발화 지연 검증 아님.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print('인증/고정 모델/후보5개/원문 보존 점검 완료. 키는 저장하거나 출력하지 않았습니다.')


if __name__ == '__main__':
    main()
