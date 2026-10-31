import pytest
from scripts.validate_managed_faq import QueryOnlyEmbeddings


def test_query_delegating_to_original_document_method_still_works():
    class Inner:
        def embed_documents(self, texts):
            return [[1.] for _ in texts]
        def embed_query(self, text):
            return self.embed_documents([text])[0]
    inner = Inner()
    guarded = QueryOnlyEmbeddings(inner)
    assert guarded.embed_query('질문') == [1.]
    assert inner.embed_documents(['원문']) == [[1.]]
    with pytest.raises(RuntimeError):
        guarded.embed_documents(['문서'])
