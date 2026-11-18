from app.rag.faq_documents import FaqSearchDescription
from app.rag.faq_index import FaqIndex
from test_faq_index import prepare, refresh, setup


def test_bm25_only_description_keeps_vectors_and_evidence_unchanged(setup):
    env = setup
    faq = prepare()
    env.index.apply(refresh(faq))
    calls = list(env.embeddings.calls)
    index = FaqIndex(env.state, env.vectors, env.embeddings, validate_chunks=lambda chunks:None,
        embedding_batch_size=32, bm25_weight=.4, rrf_c=60,
        bm25_descriptions={faq.faq_id:FaqSearchDescription(faq.faq_id, faq.source_sha256, '업무시간 외 신청')})
    search = index.current().search
    assert search.bm25_inputs[faq.chunks[0].point_id].endswith('검색용 설명: 업무시간 외 신청')
    assert index.current().faqs[0] == faq
    assert env.embeddings.calls == calls
    changed = prepare(answer='변경된 원문')
    index.apply(refresh(changed))
    assert index.current().search.bm25_inputs[changed.chunks[0].point_id] == changed.chunks[0].embedding_text
