"""검증한 large+검색 설명으로 새 컬렉션만 등록한다. 기존 자료는 덮어쓰지 않는다."""
import argparse
import hashlib
import os
import uuid
from pathlib import Path

from app.config import ROOT
from app.rag.algorithms import faq_documents
from app.rag.descriptions import load_descriptions, search_documents


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=ROOT/'manuals/delivery_faq.md')
    parser.add_argument('--descriptions', type=Path, default=ROOT/'config/rag-search-descriptions.json')
    parser.add_argument('--collection', default='manuals_dev_openai_large')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    raw = args.source.read_bytes()
    documents = faq_documents(raw.decode('utf-8'), args.source)
    descriptions = load_descriptions(args.descriptions, raw, documents)
    indexed = search_documents(documents, descriptions)
    print(f'FAQ: {len(documents)}개 / text-embedding-3-large 3072차원 / {args.collection}')
    if args.dry_run:
        print('본문과 검색 설명 해시 검사 완료. API/DB 접근 없음.')
        return
    from dotenv import load_dotenv
    from langchain_openai import OpenAIEmbeddings
    from qdrant_client import QdrantClient, models
    load_dotenv(ROOT/'.env', override=False)
    client = QdrantClient(url=os.getenv('QDRANT_URL', 'http://127.0.0.1:6333'),
                          api_key=os.environ['QDRANT_API_KEY'], timeout=30)
    try:
        if client.collection_exists(args.collection):
            raise ValueError('기존 컬렉션입니다. 새 이름을 지정하세요. 삭제/재등록하지 않습니다.')
        embedding = OpenAIEmbeddings(model='text-embedding-3-large', request_timeout=30, max_retries=1)
        vectors = embedding.embed_documents([d.page_content for d in indexed])
        if len(vectors) != len(documents) or any(len(v) != 3072 for v in vectors):
            raise ValueError('벡터 수/차원이 다릅니다.')
        client.create_collection(args.collection, vectors_config=models.VectorParams(size=3072, distance=models.Distance.COSINE))
        points = [models.PointStruct(id=str(uuid.uuid5(uuid.NAMESPACE_URL, doc.metadata['chunk_id'])), vector=vector,
            payload={'page_content': doc.page_content, 'metadata': {**doc.metadata, 'source': 'delivery_faq',
                'embedding_model': 'text-embedding-3-large', 'source_sha256': hashlib.sha256(raw).hexdigest(),
                'descriptions_sha256': hashlib.sha256(args.descriptions.read_bytes()).hexdigest()}})
            for doc, vector in zip(documents, vectors, strict=True)]
        client.upsert(args.collection, points=points, wait=True)
        if client.count(args.collection, exact=True).count != len(documents):
            raise ValueError('부분 등록 상태입니다. 이 컬렉션을 운영에 지정하지 마세요.')
        print('등록 완료. 설정 collection을 변경하기 전 검색/리랭킹을 검증하세요.')
    finally:
        client.close()


if __name__ == '__main__':
    main()
