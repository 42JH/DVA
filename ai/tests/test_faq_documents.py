"""JSON FAQ 청킹·관리 ID·벡터 재사용 입력. 외부 API나 실제 DB 없이 검증한다."""

from dataclasses import replace
import json
from uuid import UUID

import pytest
from pydantic import ValidationError

from app.config import load_server_config
from app.rag.faq_documents import (
    FaqChunkingError, FaqSearchDescription, faq_source_hash, prepare_faq_documents,
    prepare_faq_document_refresh,
)
from app.rag.faq_source import FaqEntry, FaqRefresh


def faq(**changes):
    return FaqEntry.model_validate({
        'faqEntrySeq': 123, 'question': '택배 요금은 얼마인가요?',
        'answer': '선택하신 규격에 따라 다릅니다.\n\n지점에서 확인해 주세요.  \n',
        'updatedAt': '2026-10-30T01:00:00Z', **changes,
    })


def prepare(entry=None, **changes):
    cfg = load_server_config()
    options = dict(chunk_size=cfg.faq_sync.chunk_size, chunk_overlap=cfg.faq_sync.chunk_overlap,
                   embedding_model=cfg.rag.embedding_model, dimensions=cfg.rag.dimensions)
    return prepare_faq_documents(entry or faq(), **(options | changes))


def long_answer():
    return '\n\n'.join(f'문단{i} '+chr(ord('가')+i)*400 for i in range(6))


def test_short_faq_preserves_original_and_has_stable_metadata():
    source = faq()
    result = prepare(source)
    chunk, = result.chunks
    assert result.source == source
    assert chunk.content == '### Q. '+source.question+'\n'+source.answer
    assert chunk.embedding_text == chunk.content
    assert result.faq_id == 'backend-faq:123'
    assert UUID(chunk.point_id).version == 5
    doc = chunk.document()
    assert doc.metadata['faq_id'] == result.faq_id
    assert doc.metadata['chunk_id'] == doc.metadata['_id'] == chunk.point_id
    assert doc.metadata['header_3'] == 'Q. '+source.question
    assert doc.metadata['chunk_index'] == 0 and doc.metadata['chunk_count'] == 1
    doc.metadata['header_3'] = '외부 변경'
    assert chunk.document().metadata['header_3'] == 'Q. '+source.question


def test_repeated_preparation_and_time_only_change_reuse_ids_and_hashes():
    first = prepare()
    assert prepare() == first
    timed = prepare(faq(updatedAt='2026-10-30T05:00:00.000+00:00'))
    assert timed.source.updated_at != first.source.updated_at
    assert timed.chunks == first.chunks and timed.version == first.version


def test_same_question_and_answer_with_different_ids_stay_separate():
    first, other = prepare(), prepare(faq(faqEntrySeq=124))
    assert first.faq_id != other.faq_id
    assert first.chunks[0].point_id != other.chunks[0].point_id
    assert first.chunks[0].embedding_sha256 == other.chunks[0].embedding_sha256


def test_question_change_changes_every_child_embedding_and_point():
    source = faq(answer=long_answer())
    first = prepare(source)
    changed = prepare(source.model_copy(update={'question': '배송비 기준은 무엇인가요?'}))
    assert len(first.chunks) > 1
    assert not ({c.embedding_sha256 for c in first.chunks} & {c.embedding_sha256 for c in changed.chunks})
    assert not ({c.point_id for c in first.chunks} & {c.point_id for c in changed.chunks})


def test_answer_change_can_reuse_unchanged_child_vectors_but_stages_new_points():
    source = faq(answer=long_answer())
    first = prepare(source)
    changed = prepare(source.model_copy(update={'answer': source.answer[:-5]+'수정된내용'}))
    assert first.source_sha256 != changed.source_sha256 and first.version != changed.version
    assert {c.embedding_sha256 for c in first.chunks} & {c.embedding_sha256 for c in changed.chunks}
    assert not ({c.point_id for c in first.chunks} & {c.point_id for c in changed.chunks})


def test_model_dimension_and_actual_whitespace_change_embedding_cache_key():
    first = prepare()
    assert prepare(dimensions=1536).chunks[0].embedding_sha256 != first.chunks[0].embedding_sha256
    assert prepare(embedding_model='another-model').version != first.version
    assert prepare(faq(answer=faq().answer+' ')).source_sha256 != first.source_sha256


def test_valid_description_is_search_only_and_invalid_binding_is_rejected():
    source = faq()
    description = FaqSearchDescription('backend-faq:123', faq_source_hash(source), ' 요금·규격 안내 ')
    result = prepare(source, description=description)
    chunk = result.chunks[0]
    assert chunk.embedding_text == chunk.content+'\n\n검색용 설명: 요금·규격 안내'
    assert '검색용 설명' not in chunk.document().page_content
    assert result.source_sha256 == prepare(source).source_sha256
    assert result.version != prepare(source).version
    for invalid in (replace(description, faq_id='backend-faq:124'),
                    replace(description, source_sha256='stale'), replace(description, text=' ')):
        with pytest.raises(ValueError):
            prepare(source, description=invalid)
    with pytest.raises(ValueError):
        prepare(faq(answer='다른 원문'), description=description)


def test_long_plain_answer_repeats_question_and_respects_total_character_limit():
    source = faq(answer=long_answer())
    result = prepare(source)
    assert len(result.chunks) > 1
    for index, chunk in enumerate(result.chunks):
        assert chunk.content.startswith('### Q. '+source.question+'\n')
        assert len(chunk.content) <= 800
        assert chunk.index == index and chunk.count == len(result.chunks)
    for i in range(6):
        assert any(f'문단{i}' in chunk.content for chunk in result.chunks)


def test_long_table_repeats_question_heading_headers_and_conditions_without_losing_rows():
    rows = [f'| 품목{i:03d} | {4000+i}원 |\n' for i in range(100)]
    header = '| 규격 | 유인 지점 |\n| --- | --- |\n'
    source = faq(answer='## 요금 안내\nVAT 포함입니다.\n\n'+header+''.join(rows)+'\n지점에 따라 달라질 수 있습니다.\n')
    result = prepare(source)
    assert len(result.chunks) > 1
    for chunk in result.chunks:
        assert len(chunk.content) <= 800
        assert '### Q. '+source.question in chunk.content
        assert '## 요금 안내' in chunk.content and header in chunk.content
        assert 'VAT 포함입니다.' in chunk.content and '지점에 따라 달라질 수 있습니다.' in chunk.content
    for row in rows:
        assert sum(chunk.content.count(row) for chunk in result.chunks) == 1


def test_escaped_and_inline_code_pipes_are_not_extra_columns():
    rows = [f'| `x|y` 품목{i:02d} \\| 표시 | 4,950원 |\n' for i in range(40)]
    result = prepare(faq(answer='항목은 다음과 같습니다.\n\n| 항목 | 요금 |\n| :--- | ---: |\n'+''.join(rows)))
    for row in rows:
        assert sum(c.content.count(row) for c in result.chunks) == 1


def test_bulleted_tax_and_parent_list_conditions_follow_long_table():
    rows = ''.join(f'| 물품{i:03d} | 4,950원 |\n' for i in range(80))
    source = faq(answer='- 공통: 유인 기준입니다.\n\n## 요금\n- VAT 포함입니다.\n\n'
                 '| 규격 | 요금 |\n| --- | --- |\n'+rows)
    result = prepare(source)
    tables = [c for c in result.chunks if '| 규격 | 요금 |' in c.content]
    assert len(tables) > 1
    assert all('- 공통: 유인 기준입니다.' in c.content and '- VAT 포함입니다.' in c.content for c in tables)


def test_nested_heading_is_repeated_with_each_child():
    result = prepare(faq(answer='## 포장\n### 깨지기 쉬운 물건\n'+long_answer()))
    assert len(result.chunks) > 1
    assert all('## 포장\n### 깨지기 쉬운 물건\n' in c.content for c in result.chunks)


def test_parent_and_root_conditions_follow_child_table_but_not_sibling_notes():
    rows = ''.join(f'| 물품{i:03d} | 4,950원 |\n' for i in range(80))
    table = '| 규격 | 요금 |\n| --- | --- |\n'+rows
    source = faq(answer='공통 조건: VAT 포함.\n\n## 유인\n유인 지점만 적용.\n\n### 소형\n'+table+
                 '\n## 무인\n무인 조건은 별도입니다.\n\n### 소형\n'+table)
    result = prepare(source)
    tables = [c for c in result.chunks if '| 규격 | 요금 |' in c.content]
    assert tables and all('공통 조건: VAT 포함.' in c.content for c in tables)
    manned = [c for c in tables if '## 유인\n' in c.content]
    unmanned = [c for c in tables if '## 무인\n' in c.content]
    assert manned and unmanned
    assert all('유인 지점만 적용.' in c.content and '무인 조건은 별도입니다.' not in c.content for c in manned)
    assert all('무인 조건은 별도입니다.' in c.content and '유인 지점만 적용.' not in c.content for c in unmanned)


def test_fenced_code_is_atomic_and_its_headings_and_tables_are_not_parsed():
    code = '```text\n## 코드 안의 제목\n| a | b |\n| --- | --- |\n| x | y |\n```\n'
    source = faq(answer='가'*900+'\n\n'+code+'\n'+'나'*900)
    result = prepare(source)
    assert sum(code in c.content for c in result.chunks) == 1
    assert all('## 코드 안의 제목' not in c.content for c in result.chunks if code not in c.content)


def test_long_list_preserves_prohibition_context_and_whole_nested_items():
    items = [f'- 물품{i:03d}\n  - 추가 조건{i:03d}\n' for i in range(80)]
    result = prepare(faq(question='어떤 물품을 보낼 수 있나요?',
                         answer='아래 물품은 취급금지입니다.\n\n'+''.join(items)+'\n예외는 상담원에게 문의해 주세요.'))
    assert len(result.chunks) > 1
    for chunk in result.chunks:
        assert len(chunk.content) <= 800
        assert '아래 물품은 취급금지입니다.' in chunk.content
        assert '예외는 상담원에게 문의해 주세요.' in chunk.content
    for item in items:
        assert sum(chunk.content.count(item) for chunk in result.chunks) == 1


def test_numbered_list_is_split_by_whole_items():
    items = [f'{i+1}. 작업{i:03d}\n' for i in range(100)]
    result = prepare(faq(answer='진행 순서입니다.\n\n'+''.join(items)))
    assert len(result.chunks) > 1
    for item in items:
        assert sum(chunk.content.count(item) for chunk in result.chunks) == 1


def test_oversized_nested_list_item_is_not_detached_from_parent():
    with pytest.raises(FaqChunkingError, match='목록 한 항목'):
        prepare(faq(answer='아래는 취급금지입니다.\n\n- 큰 항목\n  - '+'조건'*500))


@pytest.mark.parametrize('answer', [
    '| 항목 | 요금 |\n| --- | --- |\n| '+'가'*900+' | 100원 |\n',
    '| 항목 | 요금 |\n| --- | --- |\n'+''.join('| a | b | c |\n' for _ in range(100)),
    '필수조건 '+'가'*900+'\n\n| 항목 | 요금 |\n| --- | --- |\n| a | b |\n',
    '```text\n'+'가'*900+'\n```\n',
    '```text\n'+'가'*900,
])
def test_unsupported_long_structure_fails_without_silent_truncation(answer):
    with pytest.raises(FaqChunkingError):
        prepare(faq(answer=answer))


def test_long_question_cannot_silently_use_up_body_budget():
    with pytest.raises(FaqChunkingError):
        prepare(faq(question='질'*790, answer='답'*200))


@pytest.mark.parametrize('options', [
    {'chunk_size':0}, {'chunk_overlap':-1}, {'chunk_overlap':800},
    {'chunk_size':True}, {'dimensions':True}, {'dimensions':0}, {'embedding_model':' '},
])
def test_invalid_chunk_or_embedding_contract_is_rejected(options):
    with pytest.raises(ValueError):
        prepare(**options)


def test_server_config_rejects_overlap_larger_than_chunk():
    cfg = load_server_config()
    with pytest.raises(ValidationError):
        type(cfg.faq_sync).model_validate(cfg.faq_sync.model_dump() | {'chunk_size':50,'chunk_overlap':50})


def test_batch_preserves_ids_and_deletes_and_does_not_skip_bad_faq():
    cfg = load_server_config()
    options = dict(chunk_size=cfg.faq_sync.chunk_size, chunk_overlap=cfg.faq_sync.chunk_overlap,
                   embedding_model=cfg.rag.embedding_model, dimensions=cfg.rag.dimensions)
    event = FaqRefresh('event-for-test', (faq(), faq(faqEntrySeq=124)), (125,))
    result = prepare_faq_document_refresh(event, **options)
    assert result.event_id == event.event_id and result.delete_ids == (125,)
    assert [item.faq_id for item in result.upserts] == ['backend-faq:123', 'backend-faq:124']
    invalid = faq(faqEntrySeq=124, question='질'*790, answer='답'*200)
    with pytest.raises(FaqChunkingError):
        prepare_faq_document_refresh(replace(event, upserts=(faq(), invalid)), **options)
    deleted = prepare_faq_document_refresh(FaqRefresh('delete', (), (123,124)), **options)
    assert deleted.upserts == () and deleted.delete_ids == (123,124)


def test_inspection_cli_uses_config_and_prints_offline_result(tmp_path, monkeypatch, capsys):
    from scripts.inspect_faq_json import main
    path = tmp_path/'faq-api-response.json'
    path.write_text(json.dumps({'data':[faq().model_dump(by_alias=True)],'hasNext':False}), encoding='utf-8')
    monkeypatch.setattr('sys.argv', ['inspect_faq_json', str(path), '--show-chunks'])
    main()
    printed = capsys.readouterr().out
    assert 'backend-faq:123' in printed and '전체 청크 수: 1' in printed
    assert faq().answer in printed and '오프라인 변환만 수행' in printed
