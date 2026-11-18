"""운영과 동일한 RAG를 질문 한 개로 점검한다. 원문·시간만 출력하며 답변을 생성하지 않는다."""
import argparse
import asyncio
import json

from app.config import ROOT, load_server_config
from app.rag.service import RagService


async def search(question):
    service = RagService(load_server_config().rag)
    try:
        result = await service(question)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    finally:
        await service.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('question')
    args = parser.parse_args()
    if not args.question.strip() or len(args.question) > 500:
        parser.error('1~500자 질문이 필요합니다.')
    from dotenv import load_dotenv
    load_dotenv(ROOT/'.env', override=False)
    asyncio.run(search(args.question))


if __name__ == '__main__':
    main()
