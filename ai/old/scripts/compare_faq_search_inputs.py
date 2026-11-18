"""저장된 동일 벡터 순위를 고정하고 BM25 검색 설명 유무만 비교한다. 외부 호출 없음."""
import json
from pathlib import Path

from app.config import ROOT
from app.rag.algorithms import rank_bm25, fuse
from app.rag.faq_documents import prepare_faq_documents
from app.rag.faq_source import FaqEntry
from app.rag.hybrid import HybridSearchExperiment


def main():
    report = json.loads((ROOT/'data/private/evaluation/managed-faq-validation-20261031.json').read_text(encoding='utf-8'))
    docs = [chunk.document() for item in report['source'] for chunk in prepare_faq_documents(
        FaqEntry.model_validate(item), chunk_size=800, chunk_overlap=50,
        embedding_model='text-embedding-3-large', dimensions=3072).chunks]
    by_title = {doc.metadata['header_3']:doc for doc in docs}
    descriptions = {item['faq_title']:item['description'] for item in json.loads(
        (ROOT/'config/rag-search-descriptions.json').read_text(encoding='utf-8'))['entries']}
    output = {'scope':'오프라인: 동일 BE 원문과 저장 벡터 순위 고정, BM25 설명만 변경. 재임베딩/리랭킹 없음.', 'variants':{}}
    for label, desc in [('without_description',{}), ('bm25_description_only', descriptions)]:
        search = HybridSearchExperiment(docs, None, None, bm25_weight=.4, c=60, descriptions=desc)
        records = []
        for row in report['records']:
            tokens = search.preprocess(row['question'])
            bm = rank_bm25(docs, search.bm25.vectorizer.get_scores(tokens), tokens, search.corpus_tokens)
            dense = [by_title[item['title']] for item in row['dense_results']]
            ranked = fuse([by_title[item['title']] for item in bm], dense, bm25_weight=.4, c=60)
            rank = next((i for i,item in enumerate(ranked,1) if item['title'] in row['expected']), None)
            records.append({'id':row['id'],'rrf_rank':rank,'hit5':int(rank is not None and rank<=5)})
            if row['id'] == 'faq_03_02':
                output.setdefault('target',{})[label] = {'query_tokens':tokens,
                    'bm25_rank':next((i for i,item in enumerate(bm,1) if item['title'] in row['expected']),None),
                    'rrf_rank':rank,'top5':[item['title'] for item in ranked[:5]]}
        output['variants'][label] = {'hit5_count':sum(item['hit5'] for item in records),'records':records}
    target = by_title['Q. 이용 가능 시간은 언제인가요?']
    output['target_content'] = target.page_content
    output['target_description'] = descriptions['Q. 이용 가능 시간은 언제인가요?']
    path = ROOT/'data/private/evaluation/faq-description-ablation-20261031.json'
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({**output,'variants':{key:{'hit5_count':value['hit5_count']} for key,value in output['variants'].items()}},ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
