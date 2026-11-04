"""검증된 JSON FAQ → 질문 문맥을 가진 검색 청크. 외부 호출/벡터 쓰기 없음."""

import hashlib
import json
import re
from dataclasses import dataclass
from uuid import UUID, uuid5

from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter

from app.rag.descriptions import search_documents
from app.rag.faq_source import FaqEntry, FaqRefresh


FORMAT = 'backend-faq-v1'
NAMESPACE = UUID('69e66852-15f3-51a2-98a7-a4c4efad4634')
_HEADING = re.compile(r'^ {0,3}(#{1,6})[ \t]+\S')
_FENCE = re.compile(r'^ {0,3}(`{3,}|~{3,})(.*)$')
_SEPARATOR = re.compile(r':?-{3,}:?')
_LIST = re.compile(r'^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+\S')


class FaqChunkingError(ValueError):
    """구조를 보존하면서 길이 제한을 지킬 수 없다. 조용히 자르지 않는다."""


def _hash(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':')).encode('utf-8')).hexdigest()


def faq_source_hash(entry: FaqEntry) -> str:
    # 관리번호/수정시각은 임베딩할 본문이 아니다.
    return _hash({'question': entry.question, 'answer': entry.answer})


@dataclass(frozen=True)
class FaqSearchDescription:
    faq_id: str
    source_sha256: str
    text: str


@dataclass(frozen=True)
class FaqChunk:
    faq_id: str
    faq_version: str
    source_sha256: str
    point_id: str
    index: int
    count: int
    title: str
    content: str
    embedding_text: str
    embedding_sha256: str
    embedding_model: str
    dimensions: int

    def document(self) -> Document:
        # 호출자가 메타데이터를 바꿔도 준비된 청크의 내용/ID는 바뀌지 않는다.
        return Document(page_content=self.content, metadata={
            'source': self.faq_id, 'source_kind': 'backend_faq', 'faq_id': self.faq_id,
            'faq_version': self.faq_version, 'source_sha256': self.source_sha256,
            'chunk_id': self.point_id, '_id': self.point_id,
            'chunk_index': self.index, 'chunk_count': self.count, 'header_3': self.title,
            'embedding_sha256': self.embedding_sha256,
            'embedding_model': self.embedding_model, 'dimensions': self.dimensions,
            'format': FORMAT,
        })


@dataclass(frozen=True)
class FaqDocuments:
    source: FaqEntry
    faq_id: str
    version: str
    source_sha256: str
    chunks: tuple[FaqChunk, ...]


@dataclass(frozen=True)
class FaqDocumentRefresh:
    event_id: str
    upserts: tuple[FaqDocuments, ...]
    delete_ids: tuple[int, ...]


def _fence_state(line: str, opened: str | None) -> str | None:
    match = _FENCE.match(line.rstrip('\r\n'))
    if match is None:
        return opened
    marker, rest = match.groups()
    if opened is None:
        return marker
    if marker[0] == opened[0] and len(marker) >= len(opened) and not rest.strip():
        return None
    return opened


def _sections(answer: str):
    headings, buffered, opened, root_prose = [], [], None, ''

    def inherited():
        return '\n\n'.join(value for value in [root_prose, *(prose for _, _, prose in headings[:-1])] if value)

    for line in answer.splitlines(keepends=True):
        heading = _HEADING.match(line) if opened is None else None
        if heading:
            level = len(heading[1])
            text = ''.join(buffered)
            if text.strip() or (headings and level <= headings[-1][0]):
                yield tuple(title for _, title, _ in headings), text, inherited()
            # 상위 절의 조건은 글머리표일 수도 있다. 본문 전체를 문맥으로 보존한다.
            prose = text.strip()
            if headings:
                depth, title, _ = headings[-1]
                headings[-1] = (depth, title, prose)
            else:
                root_prose = prose
            buffered = []
            headings = [(depth, title, note) for depth, title, note in headings if depth < level]
            headings.append((level, line.rstrip('\r\n'), ''))
        else:
            buffered.append(line)
        opened = _fence_state(line, opened)
    if opened is not None:
        raise FaqChunkingError('닫히지 않은 코드 블록입니다.')
    if ''.join(buffered).strip() or headings:
        yield tuple(title for _, title, _ in headings), ''.join(buffered), inherited()


def _cells(line: str):
    """일반 pipe 표의 열을 센다. 이스케이프/인라인 코드의 pipe는 열 구분이 아니다."""
    text = line.strip()
    positions, code, i = [], 0, 0
    while i < len(text):
        if text[i] == '\\':
            i += 2
            continue
        if text[i] == '`':
            end = i+1
            while end < len(text) and text[end] == '`':
                end += 1
            width = end-i
            code = 0 if code == width else width if code == 0 else code
            i = end
            continue
        if text[i] == '|' and not code:
            positions.append(i)
        i += 1
    if not positions:
        return None
    cells, start = [], 0
    for position in positions:
        cells.append(text[start:position])
        start = position+1
    cells.append(text[start:])
    if positions[0] == 0:
        cells.pop(0)
    if positions[-1] == len(text)-1:
        cells.pop()
    return cells


def _blocks(text: str):
    lines, plain, i = text.splitlines(keepends=True), [], 0
    while i < len(lines):
        fence = _FENCE.match(lines[i].rstrip('\r\n'))
        listing = _LIST.match(lines[i])
        separator = _cells(lines[i+1]) if i+1 < len(lines) else None
        table = bool(separator and all(_SEPARATOR.fullmatch(cell.strip()) for cell in separator))
        if fence or table or listing:
            if ''.join(plain).strip():
                yield 'text', ''.join(plain)
            plain = []
        if fence:
            start, opened = i, _fence_state(lines[i], None)
            i += 1
            while i < len(lines) and opened is not None:
                opened = _fence_state(lines[i], opened)
                i += 1
            if opened is not None:
                raise FaqChunkingError('닫히지 않은 코드 블록입니다.')
            yield 'code', ''.join(lines[start:i])
        elif table:
            cells = _cells(lines[i])
            if cells is None or len(cells) != len(separator):
                raise FaqChunkingError('표 머리글과 구분행의 열 수가 다릅니다.')
            start, width = i, len(cells)
            i += 2
            while i < len(lines) and (row := _cells(lines[i])) is not None:
                if len(row) != width:
                    raise FaqChunkingError('표 데이터 행의 열 수가 다릅니다.')
                i += 1
            yield 'table', ''.join(lines[start:i])
        elif listing:
            start, indent = i, len(listing[1].expandtabs(4))
            i += 1
            while i < len(lines):
                if not lines[i].strip():
                    following = i+1
                    while following < len(lines) and not lines[following].strip():
                        following += 1
                    if following == len(lines):
                        break
                    next_line = lines[following]
                    depth = len(next_line)-len(next_line.lstrip(' \t'))
                    if not _LIST.match(next_line) and depth <= indent:
                        break
                i += 1
            yield 'list', ''.join(lines[start:i])
        else:
            plain.append(lines[i])
            i += 1
    if ''.join(plain).strip():
        yield 'text', ''.join(plain)


def _table_chunks(prefix: str, table: str, size: int):
    lines = table.splitlines(keepends=True)
    header = ''.join(lines[:2])
    current = prefix+header
    if len(current) > size:
        raise FaqChunkingError('질문·표 문맥·머리글이 청크 크기를 넘습니다.')
    rows = 0
    for row in lines[2:]:
        if len(prefix+header+row) > size:
            raise FaqChunkingError('표 한 행을 문맥과 함께 담을 수 없습니다.')
        if len(current+row) > size:
            yield current
            current, rows = prefix+header, 0
        current += row
        rows += 1
    if rows or len(lines) == 2:
        yield current


def _list_chunks(prefix: str, text: str, size: int):
    items, buffered = [], []
    lines = text.splitlines(keepends=True)
    indent = len(_LIST.match(lines[0])[1].expandtabs(4))
    for line in lines:
        marker = _LIST.match(line)
        if marker and len(marker[1].expandtabs(4)) == indent and buffered:
            items.append(''.join(buffered))
            buffered = []
        buffered.append(line)
    if buffered:
        items.append(''.join(buffered))
    current = prefix
    for item in items:
        if len(prefix+item) > size:
            raise FaqChunkingError('목록 한 항목을 상위 문맥과 함께 담을 수 없습니다.')
        if len(current+item) > size:
            yield current
            current = prefix
        current += item
    if current != prefix:
        yield current


def _contents(entry: FaqEntry, size: int, overlap: int) -> tuple[str, ...]:
    question = f'### Q. {entry.question}\n'
    whole = question+entry.answer
    # 짧은 FAQ는 원문 공백/표/개행을 그대로 유지한다.
    if len(whole) <= size:
        return (whole,)
    output = []
    for headings, text, parent_prose in _sections(entry.answer):
        prefix = question+''.join(heading+'\n' for heading in headings)
        prefix += parent_prose+'\n\n' if parent_prose else ''
        blocks = list(_blocks(text))
        if not blocks:
            if len(prefix) > size:
                raise FaqChunkingError('질문·절 제목이 청크 크기를 넘습니다.')
            output.append(prefix)
            continue
        has_structure = any(kind in ('table', 'list') for kind, _ in blocks)
        # VAT/금지·예외 조건이 앞이나 뒤에 있을 수 있어 같은 절의 일반 설명을 반복한다.
        prose = '\n\n'.join(value.strip() for kind, value in blocks if kind == 'text') if has_structure else ''
        context = prefix+(prose+'\n\n' if prose else '')
        table_notes = '\n\n'.join(value.strip() for kind, value in blocks if kind != 'table')
        table_context = prefix+(table_notes+'\n\n' if table_notes else '')
        for kind, value in blocks:
            if kind == 'table':
                output.extend(_table_chunks(table_context, value, size))
            elif kind == 'list':
                output.extend(_list_chunks(context, value, size))
            elif kind == 'code':
                if len(context+value) > size:
                    raise FaqChunkingError('코드 블록을 문맥과 함께 담을 수 없습니다.')
                output.append(context+value)
            elif not has_structure:
                budget = size-len(prefix)
                if budget <= 0 or overlap >= budget:
                    raise FaqChunkingError('질문·절 제목 뒤에 본문과 겹침을 담을 공간이 부족합니다.')
                splitter = RecursiveCharacterTextSplitter(chunk_size=budget, chunk_overlap=overlap, length_function=len)
                output.extend(prefix+part for part in splitter.split_text(value))
    if not output:
        raise FaqChunkingError('FAQ 청크가 없습니다.')
    return tuple(output)


def prepare_faq_documents(entry: FaqEntry, *, chunk_size: int, chunk_overlap: int,
                          embedding_model: str, dimensions: int,
                          description: FaqSearchDescription | None = None) -> FaqDocuments:
    if type(chunk_size) is not int or type(chunk_overlap) is not int or not 0 <= chunk_overlap < chunk_size:
        raise ValueError('청크 크기/겹침이 올바르지 않습니다.')
    if not embedding_model.strip() or type(dimensions) is not int or dimensions < 1:
        raise ValueError('임베딩 모델/차원이 올바르지 않습니다.')
    faq_id = f'backend-faq:{entry.faq_id}'
    source_hash = faq_source_hash(entry)
    if description is not None and (description.faq_id != faq_id or description.source_sha256 != source_hash
                                    or not description.text.strip()):
        raise ValueError('검색 설명의 FAQ 번호/원문 해시/내용이 올바르지 않습니다.')
    contents = _contents(entry, chunk_size, chunk_overlap)
    title = f'Q. {entry.question}'
    inputs = tuple(doc.page_content for doc in search_documents(
        [Document(page_content=text, metadata={'header_3': title}) for text in contents],
        {title: description.text.strip()} if description is not None else {}))
    version = _hash({'format': FORMAT, 'source': source_hash, 'contents': contents, 'inputs': inputs,
                     'model': embedding_model, 'dimensions': dimensions})
    chunks = tuple(FaqChunk(faq_id, version, source_hash,
        str(uuid5(NAMESPACE, f'{faq_id}:{version}:{index}')), index, len(contents), title, content, text,
        _hash({'format': FORMAT, 'model': embedding_model, 'dimensions': dimensions, 'text': text}),
        embedding_model, dimensions) for index, (content, text) in enumerate(zip(contents, inputs, strict=True)))
    return FaqDocuments(entry, faq_id, version, source_hash, chunks)


def prepare_faq_document_refresh(refresh: FaqRefresh, *, chunk_size: int, chunk_overlap: int,
                                 embedding_model: str, dimensions: int,
                                 descriptions: dict[str, FaqSearchDescription] | None = None) -> FaqDocumentRefresh:
    """배치 전체가 준비돼야 결과를 반환한다. 실패 항목만 조용히 제외하지 않는다."""
    descriptions = descriptions or {}
    ids = [entry.faq_id for entry in refresh.upserts]
    if len(set(ids)) != len(ids) or set(ids).intersection(refresh.delete_ids):
        raise ValueError('갱신할 FAQ가 중복되거나 삭제 대상과 겹칩니다.')
    if set(descriptions)-{f'backend-faq:{value}' for value in ids}:
        raise ValueError('갱신 대상 밖의 FAQ 검색 설명입니다.')
    documents = tuple(prepare_faq_documents(entry, chunk_size=chunk_size, chunk_overlap=chunk_overlap,
        embedding_model=embedding_model, dimensions=dimensions,
        description=descriptions.get(f'backend-faq:{entry.faq_id}')) for entry in refresh.upserts)
    return FaqDocumentRefresh(refresh.event_id, documents, refresh.delete_ids)
