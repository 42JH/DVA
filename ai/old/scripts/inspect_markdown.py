import argparse
from pathlib import Path

from app.rag.chunking import split_markdown
from app.rag.loaders.markdown import load_markdown


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("file_path", type=Path)
    parser.add_argument("--chunk-size", type=int, default=800)
    parser.add_argument("--chunk-overlap", type=int, default=50)
    args = parser.parse_args()

    documents = load_markdown(args.file_path)
    chunks = split_markdown(
        documents,
        chunk_size=args.chunk_size,
        chunk_overlap=args.chunk_overlap,
    )

    print(f"원본 Document 수: {len(documents)}")
    print(f"생성된 청크 수: {len(chunks)}")

    for number, chunk in enumerate(chunks, start=1):
        print(f"\n{'=' * 20} 청크 {number} {'=' * 20}")
        print(f"글자 수: {len(chunk.page_content)}")
        print(f"metadata: {chunk.metadata}")
        print("--- 본문 시작 ---")
        print(chunk.page_content)
        print("--- 본문 끝 ---")


if __name__ == "__main__":
    main()