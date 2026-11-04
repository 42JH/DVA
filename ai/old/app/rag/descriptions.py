"""원문과 분리한 검색용 설명을 검증하고 검색 입력에만 붙인다."""

import hashlib
import json
from pathlib import Path

from langchain_core.documents import Document


def load_descriptions(path: Path, source_bytes: bytes, documents) -> dict[str, str]:
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("source_sha256") != hashlib.sha256(source_bytes).hexdigest():
        raise ValueError("검색용 설명의 원문 해시가 다릅니다.")
    corpus = {doc.metadata["header_3"]: doc for doc in documents}
    descriptions = {}
    for entry in report["entries"]:
        title, text = entry["faq_title"], entry["description"]
        if title not in corpus or title in descriptions:
            raise ValueError("검색용 설명의 FAQ가 없거나 중복됩니다.")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("검색용 설명이 비어 있습니다.")
        body_hash = hashlib.sha256(corpus[title].page_content.encode("utf-8")).hexdigest()
        if entry.get("context_sha256") != body_hash:
            raise ValueError("검색용 설명의 FAQ 본문 해시가 다릅니다.")
        descriptions[title] = text.strip()
    if not descriptions:
        raise ValueError("검색용 설명 항목이 없습니다.")
    return descriptions


def search_documents(documents, descriptions: dict[str, str]) -> list[Document]:
    """본문/청크 ID를 보존한 원본과 검색용 복사본을 구분한다."""
    if set(descriptions) - {doc.metadata["header_3"] for doc in documents}:
        raise ValueError("문서에 없는 FAQ 설명입니다.")
    output = []
    for doc in documents:
        text = descriptions.get(doc.metadata["header_3"])
        content = doc.page_content + (f"\n\n검색용 설명: {text}" if text else "")
        output.append(Document(page_content=content, metadata=dict(doc.metadata)))
    return output
