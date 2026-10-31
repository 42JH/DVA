"""백엔드 FAQ 원문 계약과 색인 준비 입력. 조회 실패는 빈 결과가 아니다."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Annotated, Protocol

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

from app.rag.faq_events import FaqChange, FaqId


_IDS = TypeAdapter(Annotated[list[FaqId], Field(strict=True, min_length=1, max_length=100)])


def validate_faq_ids(ids: list[int]) -> tuple[int, ...]:
    values = _IDS.validate_python(ids)
    if len(set(values)) != len(values):
        raise ValueError('FAQ 번호가 중복됩니다.')
    return tuple(sorted(values))


class FaqEntry(BaseModel):
    """질문·답변의 줄바꿈과 Markdown을 그대로 보존한다."""

    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)

    faq_id: FaqId = Field(alias='faqEntrySeq')
    question: str = Field(min_length=1, max_length=1000)
    answer: str = Field(min_length=1, max_length=20000)
    updated_at: str = Field(alias='updatedAt')

    @field_validator('question', 'answer')
    @classmethod
    def valid_text(cls, value: str) -> str:
        if not value.strip() or '\x00' in value:
            raise ValueError('FAQ 원문은 비어 있거나 NUL을 포함할 수 없습니다.')
        return value

    @field_validator('updated_at')
    @classmethod
    def utc_timestamp(cls, value: str) -> str:
        parsed = datetime.fromisoformat(value)
        if 'T' not in value or parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
            raise ValueError('updatedAt은 UTC ISO 8601이어야 합니다.')
        return value


class _FaqPage(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)

    data: list[FaqEntry] = Field(max_length=100)
    has_next: bool = Field(alias='hasNext')


@dataclass(frozen=True)
class FaqLookup:
    entries: tuple[FaqEntry, ...]
    missing_ids: tuple[int, ...]


def parse_faq_lookup(payload: object, requested_ids: list[int]) -> FaqLookup:
    """검증을 모두 통과한 완전한 응답에 대해서만 누락 번호를 계산한다."""
    requested = validate_faq_ids(requested_ids)
    page = _FaqPage.model_validate(payload)
    if page.has_next:
        raise ValueError('FAQ 대상 조회가 아직 끝나지 않았습니다.')
    returned = tuple(entry.faq_id for entry in page.data)
    if len(set(returned)) != len(returned) or not set(returned).issubset(requested):
        raise ValueError('FAQ 응답 번호가 요청과 일치하지 않습니다.')
    if returned != tuple(sorted(returned)):
        raise ValueError('FAQ 응답은 번호 오름차순이어야 합니다.')
    return FaqLookup(tuple(page.data), tuple(value for value in requested if value not in returned))


class FaqSource(Protocol):
    async def faq_entries(self, ids: list[int]) -> FaqLookup: ...


def parse_initial_faqs(payload: object) -> tuple[FaqEntry, ...]:
    """최초 소규모 전체 조회만 허용한다. 부분 목록으로 이전을 시작하지 않는다."""
    page = _FaqPage.model_validate(payload)
    if page.has_next:
        raise ValueError('최초 이전은 전체 FAQ가 한 응답에 들어오는 경우만 지원합니다.')
    ids = tuple(entry.faq_id for entry in page.data)
    if len(set(ids)) != len(ids) or ids != tuple(sorted(ids)):
        raise ValueError('최초 FAQ 목록 번호가 중복되거나 정렬되지 않았습니다.')
    return tuple(page.data)


@dataclass(frozen=True)
class FaqRefresh:
    event_id: str
    upserts: tuple[FaqEntry, ...]
    delete_ids: tuple[int, ...]


async def prepare_faq_refresh(event: FaqChange, source: FaqSource) -> FaqRefresh:
    """색인 갱신용 입력만 준비한다. 큐 완료/임베딩/벡터 삭제를 실행하지 않는다."""
    ids = list(validate_faq_ids(event.faq_ids))
    if event.operation == 'DELETE':
        return FaqRefresh(event.event_id, (), tuple(ids))
    found = await source.faq_entries(ids)
    return FaqRefresh(event.event_id, found.entries, found.missing_ids)
