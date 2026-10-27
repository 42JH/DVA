from pathlib import Path

from langchain_core.documents import Document


def load_markdown(file_path: Path) -> list[Document]:
    """Markdown 파일을 읽어 본문과 출처를 반환한다."""
    if not file_path.is_file():
        raise FileNotFoundError(
            f"Markdown 파일을 찾을 수 없습니다: {file_path}"
        )

    text = file_path.read_text(encoding="utf-8")

    return [
        Document(
            page_content=text,
            metadata={
                "source": str(file_path.resolve()),
                "source_kind": "markdown",
            },
        )
    ]