"""Markdown 템플릿에 검증된 검색 근거를 채운다. 검색·LLM 호출은 하지 않는다."""

import json
from pathlib import Path

from langchain_core.prompts import PromptTemplate

from app.config import prompts_dir
from app.rag.schemas import SearchContext


class RagContextRenderer:
    """준비할 때 파일을 한 번 읽고, 검색 요청마다 같은 템플릿을 사용한다."""

    def __init__(self, template_path: Path | None = None):
        path = template_path if template_path is not None else prompts_dir() / 'rag_context.md'
        self.template = PromptTemplate.from_template(
            path.read_text(encoding='utf-8'), template_format='f-string',
        )
        if set(self.template.input_variables) != {'question', 'status', 'context'}:
            raise ValueError('RAG 템플릿 변수는 question, status, context여야 합니다.')

    def render(self, context: SearchContext) -> str:
        payload = context.llm_payload()
        # 검증된 공개 전달 필드만 사용한다. 본문은 템플릿으로 재해석하지 않는다.
        evidence = json.dumps(payload['evidence'], ensure_ascii=False, indent=2, allow_nan=False)
        return self.template.format(
            question=payload['question'], status=payload['status'], context=evidence,
        )
