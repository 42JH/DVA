from langchain_core.documents import Document
from langchain_text_splitters import (
    MarkdownHeaderTextSplitter,
    RecursiveCharacterTextSplitter,
)


def split_markdown(
    documents: list[Document],
    *,
    chunk_size: int = 800,
    chunk_overlap: int = 50,
) -> list[Document]:

    header_splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=[
            ("#", "header_1"),
            ("##", "header_2"),
            ("###", "header_3"),
        ],
        strip_headers=False,
    )

    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        length_function=len,
    )

    chunks: list[Document] = []

    for document in documents:
        if not document.page_content.strip():
            continue

        sections = header_splitter.split_text(
            document.page_content
        )

        for section in sections:
            section.metadata = {
                **document.metadata,
                **section.metadata,
            }

        chunks.extend(
            text_splitter.split_documents(sections)
        )

    return chunks
