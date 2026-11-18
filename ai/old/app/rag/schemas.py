"""검색기가 기존 LLM에 전달할 근거 계약. 답변 생성이나 도구 실행은 하지 않는다."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Evidence(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)

    chunk_id: str
    source_id: str
    title: str
    content: str
    reranker_score: float | None = Field(default=None, allow_inf_nan=False)

    @field_validator('chunk_id', 'source_id', 'title', 'content')
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('근거 ID·제목·본문은 비어 있을 수 없습니다.')
        # 표와 조건의 원래 문자열을 그대로 보존한다.
        return value


class SearchContext(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)

    question: str
    status: Literal['found', 'no_evidence']
    evidence: tuple[Evidence, ...] = Field(max_length=3)

    @field_validator('question')
    @classmethod
    def question_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('고객 질문이 필요합니다.')
        return value

    @model_validator(mode='after')
    def consistent_status(self):
        if (self.status == 'found') != bool(self.evidence):
            raise ValueError('근거 상태와 개수가 일치하지 않습니다.')
        keys = [item.chunk_id for item in self.evidence]
        if len(keys) != len(set(keys)):
            raise ValueError('같은 근거를 중복 전달할 수 없습니다.')
        return self

    def llm_payload(self) -> dict:
        """순위·출처·원문을 한 묶음으로 반환한다. 점수는 정답 보증이 아니므로 제외한다."""
        return {'status': self.status, 'question': self.question,
                'evidence': [{'rank': rank, 'chunk_id': item.chunk_id, 'source_id': item.source_id,
                              'title': item.title, 'content': item.content}
                             for rank, item in enumerate(self.evidence, 1)]}
