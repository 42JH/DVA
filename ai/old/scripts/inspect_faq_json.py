"""저장해 둔 API FAQ 원문 JSON을 오프라인으로 청킹한다. API/벡터DB를 호출하지 않는다."""

import argparse
import json
from pathlib import Path
from typing import Annotated

from pydantic import Field, TypeAdapter

from app.config import load_server_config
from app.rag.faq_documents import prepare_faq_documents
from app.rag.faq_source import FaqEntry, parse_faq_lookup, validate_faq_ids


def main():
    cfg = load_server_config()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('file_path', type=Path, help='번호/질문/답변/updatedAt을 담은 배열 또는 API 목록 응답')
    parser.add_argument('--chunk-size', type=int, default=cfg.faq_sync.chunk_size)
    parser.add_argument('--chunk-overlap', type=int, default=cfg.faq_sync.chunk_overlap)
    parser.add_argument('--show-chunks', action='store_true')
    args = parser.parse_args()
    payload = json.loads(args.file_path.read_text(encoding='utf-8'))
    entries = TypeAdapter(Annotated[list[FaqEntry], Field(min_length=1, max_length=100)]).validate_python(
        payload.get('data') if isinstance(payload, dict) else payload)
    ids = [entry.faq_id for entry in entries]
    validate_faq_ids(ids)
    if isinstance(payload, dict):
        parse_faq_lookup(payload, ids)
    # 한 항목의 실패도 결과를 일부만 성공한 것처럼 출력하지 않는다.
    prepared = [prepare_faq_documents(entry, chunk_size=args.chunk_size, chunk_overlap=args.chunk_overlap,
        embedding_model=cfg.rag.embedding_model, dimensions=cfg.rag.dimensions) for entry in entries]
    print(f'FAQ 수: {len(prepared)} / 전체 청크 수: {sum(len(item.chunks) for item in prepared)}')
    for item in prepared:
        print(f'\nFAQ: {item.faq_id} / 청크 수: {len(item.chunks)} / 질문: {item.source.question}')
        for chunk in item.chunks:
            print(f'  청크 {chunk.index+1}/{chunk.count} / 본문 {len(chunk.content)}자 / ID: {chunk.point_id}')
            print(f'  임베딩 입력 해시: {chunk.embedding_sha256}')
            if args.show_chunks:
                print(chunk.content)
    print('\n오프라인 변환만 수행했습니다. Qwen 실제 토큰 길이·검색 성능·색인 반영은 별도 검증 대상입니다.')


if __name__ == '__main__':
    main()
