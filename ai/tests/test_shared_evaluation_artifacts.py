"""공유 자료가 Windows/Linux에서 같은 실제 근거와 바이트 해시를 가리키는지 검증한다."""
import hashlib
import json

from app.config import ROOT
from app.rag.algorithms import faq_documents
from app.rag.descriptions import load_descriptions


def test_shared_source_cases_descriptions_and_record_count_are_consistent():
    directory = ROOT/'evaluation/datasets/faq_v1'
    manifest = json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
    raw = (directory/'cases.json').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest['cases_raw_sha256']
    assert hashlib.sha256(raw.replace(b'\r\n', b'\n')).hexdigest() == manifest['cases_sha256']
    source = (ROOT/'manuals/delivery_faq.md').read_bytes()
    assert hashlib.sha256(source).hexdigest() == manifest['source_sha256']
    docs = faq_documents(source.decode('utf-8'), ROOT/'manuals/delivery_faq.md')
    assert len(docs) == 32
    load_descriptions(ROOT/'config/rag-search-descriptions.json', source, docs)
    by_id = {doc.metadata['chunk_id']: doc.page_content for doc in docs}
    cases = json.loads(raw)
    assert len(cases) == manifest['question_count'] == 95
    for case in cases:
        assert all(by_id[row['chunk_id']] == row['content'] for row in case['reference_evidence'])
    result = json.loads((ROOT/'evaluation/results/live_baseline_cases.json').read_text(encoding='utf-8'))
    assert len(result['records']) == 95
    assert {row['id'] for row in cases} == {row['id'] for row in result['records']}
