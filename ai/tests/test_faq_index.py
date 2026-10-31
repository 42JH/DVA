"""문서 갱신은 임시 SQLite+로컬 Qdrant+가짜 임베딩으로 검증한다."""

import hashlib
import math
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from qdrant_client import QdrantClient, models

from app.config import load_server_config
from app.rag.faq_documents import FaqSearchDescription, faq_source_hash, prepare_faq_documents, FaqDocumentRefresh
from app.rag.faq_events import FaqEventStore
from app.rag.faq_index import FaqIndex
from app.rag.faq_index_state import FaqIndexState
from app.rag.faq_source import FaqEntry
from app.rag.faq_vectors import QdrantFaqVectors


class Embeddings:
    def __init__(self, dimensions):
        self.dimensions, self.calls, self.queries = dimensions, [], []

    def vector(self, text):
        digest = hashlib.sha256(text.encode()).digest()
        values = [(digest[i % len(digest)]+1)/256 for i in range(self.dimensions)]
        norm = math.hypot(*values)
        return [number/norm for number in values]

    def embed_documents(self, texts):
        self.calls.append(list(texts))
        return [self.vector(text) for text in texts]

    def embed_query(self, text):
        self.queries.append(text)
        return self.vector(text)


def prepare(number=123, answer='기본 접수 안내입니다.', *, description=None):
    entry = FaqEntry.model_validate({'faqEntrySeq':number,'question':'접수 안내는 무엇인가요?',
        'answer':answer,'updatedAt':'2026-10-30T00:00:00Z'})
    desc = FaqSearchDescription(f'backend-faq:{number}',faq_source_hash(entry),description) if description else None
    return prepare_faq_documents(entry,chunk_size=800,chunk_overlap=50,
        embedding_model='test-embedding',dimensions=4,description=desc)


def refresh(*faqs, delete_ids=()):
    return FaqDocumentRefresh('test-event',tuple(faqs),tuple(delete_ids))


@pytest.fixture
def setup(tmp_path):
    client=QdrantClient(':memory:')
    client.create_collection('faq-managed-test',vectors_config=models.VectorParams(size=4,distance=models.Distance.COSINE))
    events=FaqEventStore(tmp_path/'events.sqlite3',max_pending=100,busy_timeout_sec=.1)
    state=FaqIndexState(events,collection='faq-managed-test',model='test-embedding',dimensions=4)
    vectors=QdrantFaqVectors(client,collection='faq-managed-test',dimensions=4)
    embeddings=Embeddings(4)
    validated=[]
    def validate(chunks):
        validated.append(tuple(chunks))
        assert all(len(chunk.content)<=800 for chunk in chunks)
    def new_index():
        return FaqIndex(state,vectors,embeddings,validate_chunks=validate,embedding_batch_size=1,bm25_weight=.4,rrf_c=60)
    env=SimpleNamespace(client=client,events=events,state=state,vectors=vectors,
                        embeddings=embeddings,validated=validated,new_index=new_index)
    env.index=new_index()
    yield env
    client.close()


def test_add_updates_bm25_and_dense_from_same_generation_and_restart(setup):
    env=setup
    original=prepare()
    snap=env.index.apply(refresh(original))
    assert snap.generation==1 and snap.point_ids==tuple(c.point_id for c in original.chunks)
    found=snap.search.search('접수',top_k=5)
    assert {row['chunk_id'] for row in found['all_results']}==set(snap.point_ids)
    calls=list(env.embeddings.calls)
    restarted=env.new_index()
    assert restarted.current().point_ids==snap.point_ids
    assert env.embeddings.calls==calls
    assert env.state.read()==(1,(original,))


def test_retry_or_unchanged_source_does_not_reembed_or_rewrite(setup,monkeypatch):
    env=setup
    first=prepare()
    env.index.apply(refresh(first))
    def forbidden(*args,**kwargs):
        pytest.fail('같은 판본은 벡터를 다시 쓰면 안 된다.')
    monkeypatch.setattr(env.vectors,'stage',forbidden)
    assert env.index.apply(refresh(first)).generation==1
    assert len(env.embeddings.calls)==1


def test_add_another_faq_reuses_same_input_but_keeps_separate_ids(setup):
    env=setup
    first=env.index.apply(refresh(prepare()))
    second=env.index.apply(refresh(prepare(124)))
    assert len(env.embeddings.calls)==1
    assert len(second.faqs)==2 and set(first.point_ids)<set(second.point_ids)
    with env.events.connect() as db:
        assert db.execute('SELECT count(*) FROM faq_cache_refs').fetchone()[0]==2


def test_partial_child_edit_reuses_unchanged_embeddings(setup):
    env=setup
    answer='\n\n'.join(f'문단{i} '+chr(ord('가')+i)*400 for i in range(6))
    first=prepare(answer=answer)
    env.index.apply(refresh(first))
    before=sum(map(len,env.embeddings.calls))
    changed=prepare(answer=answer[:-5]+'수정된내용')
    old={chunk.embedding_sha256 for chunk in first.chunks}
    missing={chunk.embedding_sha256 for chunk in changed.chunks}-old
    env.index.apply(refresh(changed))
    assert sum(map(len,env.embeddings.calls))-before==len(missing)
    assert len(missing)<len(changed.chunks)


def test_embedding_failure_keeps_snapshot_and_previous_successful_batches(setup,monkeypatch):
    env=setup
    baseline=env.index.current()
    real=env.embeddings.embed_documents
    attempts=[]
    def fail_second(texts):
        attempts.append(texts)
        if len(attempts)==2:
            raise TimeoutError('test-only')
        return real(texts)
    monkeypatch.setattr(env.embeddings,'embed_documents',fail_second)
    change=refresh(prepare(),prepare(124,answer='새로운 안내입니다.'))
    with pytest.raises(TimeoutError):
        env.index.apply(change)
    assert env.index.current() is baseline and env.state.read()[0]==0
    monkeypatch.setattr(env.embeddings,'embed_documents',real)
    env.index.apply(change)
    assert sum(map(len,env.embeddings.calls))==2


@pytest.mark.parametrize('vectors', [[], [[1.,0.,0.]], [[0.,0.,0.,0.]],
    [[True,0.,0.,1.]], [[float('nan'),0.,0.,1.]], [[float('inf'),0.,0.,1.]]])
def test_invalid_embedding_never_publishes(setup,monkeypatch,vectors):
    env=setup
    monkeypatch.setattr(env.embeddings,'embed_documents',lambda texts:vectors)
    with pytest.raises(ValueError):
        env.index.apply(refresh(prepare()))
    assert env.state.read()[0]==0 and env.index.current().point_ids==()


def test_timeout_after_qdrant_commits_retries_same_ids_from_disk_cache(setup,monkeypatch):
    env=setup
    actual=env.vectors.stage
    def lost_response(pairs):
        actual(pairs)
        raise TimeoutError('서버에는 썼지만 응답을 잃음')
    monkeypatch.setattr(env.vectors,'stage',lost_response)
    change=refresh(prepare())
    with pytest.raises(TimeoutError):
        env.index.apply(change)
    assert env.client.count('faq-managed-test').count==1
    assert env.index.current().generation==0 and env.state.read()[0]==0
    monkeypatch.setattr(env.vectors,'stage',actual)
    restarted=env.new_index()
    restarted.apply(change)
    assert len(env.embeddings.calls)==1 and env.client.count('faq-managed-test').count==1


def test_snapshot_commit_failure_does_not_publish_and_can_retry(setup,monkeypatch):
    env=setup
    actual=env.state.commit
    def fail(*args,**kwargs):
        raise OSError('disk error')
    monkeypatch.setattr(env.state,'commit',fail)
    with pytest.raises(OSError):
        env.index.apply(refresh(prepare()))
    assert env.index.current().generation==0
    monkeypatch.setattr(env.state,'commit',actual)
    env.index.apply(refresh(prepare()))
    assert len(env.embeddings.calls)==1


def test_committed_snapshot_is_recovered_after_crash_before_memory_publish(setup,monkeypatch):
    env=setup
    actual=env.state.commit
    def committed_then_stopped(*args,**kwargs):
        actual(*args,**kwargs)
        raise OSError('커밋 직후 프로세스 종료 상황')
    monkeypatch.setattr(env.state,'commit',committed_then_stopped)
    with pytest.raises(OSError):
        env.index.apply(refresh(prepare()))
    assert env.index.current().generation==0 and env.state.read()[0]==1
    restarted=env.new_index()
    assert restarted.current().generation==1 and len(env.embeddings.calls)==1


def test_readers_hold_old_complete_snapshot_until_new_is_ready(setup,monkeypatch):
    env=setup
    old=env.index.apply(refresh(prepare()))
    entered,release=threading.Event(),threading.Event()
    original=env.embeddings.embed_documents
    def blocked(texts):
        entered.set()
        assert release.wait(5)
        return original(texts)
    monkeypatch.setattr(env.embeddings,'embed_documents',blocked)
    with ThreadPoolExecutor(max_workers=1) as pool:
        task=pool.submit(env.index.apply,refresh(prepare(answer='변경 후의 접수 안내입니다.')))
        try:
            assert entered.wait(5)
            assert env.index.current() is old
            found=old.search.search('접수',top_k=5)
            assert {row['chunk_id'] for row in found['all_results']}==set(old.point_ids)
        finally:
            release.set()
        new=task.result(timeout=5)
    assert env.index.current() is new and new.generation==old.generation+1
    assert set(old.point_ids).isdisjoint(new.point_ids)
    assert {row['chunk_id'] for row in old.search.search('접수')['all_results']}==set(old.point_ids)
    assert {row['chunk_id'] for row in new.search.search('접수')['all_results']}==set(new.point_ids)


def test_search_description_is_used_for_bm25_but_never_returned_as_evidence(setup):
    env=setup
    snap=env.index.apply(refresh(prepare(description='착불')))
    found=snap.search.search('착불',top_k=5)
    assert found['bm25_results'] and found['bm25_results'][0]['matched_tokens']==['착불']
    assert all('검색용 설명:' not in row['context'] for row in found['all_results'])


def test_registration_validation_happens_before_embedding_or_vector_write(setup):
    env=setup
    def invalid(chunks):
        raise ValueError('Qwen 길이 검증 실패를 가정')
    env.index.validate_chunks=invalid
    with pytest.raises(ValueError):
        env.index.apply(refresh(prepare()))
    assert env.embeddings.calls==[] and env.client.count('faq-managed-test').count==0


def test_corrupt_cache_and_active_manifest_are_not_silently_trusted(setup):
    env=setup
    item=prepare()
    env.index.apply(refresh(item))
    with env.events.connect() as db:
        db.execute("UPDATE faq_embedding_cache SET vector='[1,0,0,0]'")
    with pytest.raises(ValueError,match='체크섬'):
        env.new_index()
    with env.events.connect() as db:
        db.execute("UPDATE faq_active_sources SET payload='{}'")
    with pytest.raises(ValueError,match='체크섬'):
        env.state.read()


def test_missing_or_changed_active_qdrant_point_blocks_restart(setup):
    env=setup
    snap=env.index.apply(refresh(prepare()))
    env.client.set_payload('faq-managed-test',payload={'page_content':'잘못 덮어쓴 본문'},points=list(snap.point_ids))
    with pytest.raises(ValueError,match='메타데이터'):
        env.new_index()


def test_state_configuration_and_optimistic_generation_are_checked(setup):
    env=setup
    with pytest.raises(ValueError,match='설정|형식'):
        FaqIndexState(env.events,collection='another',model='test-embedding',dimensions=4)
    env.index.apply(refresh(prepare()))
    with pytest.raises(RuntimeError,match='먼저 변경'):
        env.state.commit((),expected_generation=0)


def test_delete_removes_vectors_sources_and_cache_without_embedding(setup):
    env=setup
    before=env.index.apply(refresh(prepare()))
    calls=list(env.embeddings.calls)
    after=env.index.apply(refresh(delete_ids=(123,)))
    assert after.search is None and after.faqs==()
    assert before.search.search('접수')['results']==[]
    assert env.client.count('faq-managed-test').count==0 and env.state.read()[1]==()
    assert env.state.cached(prepare().chunks[0]) is None and env.embeddings.calls==calls
    assert env.events.deletion_status()=={'backend-faq:123':'CLEANED'}


def test_existing_md_collection_cannot_be_configured_as_managed_target():
    cfg=load_server_config()
    data=cfg.model_dump()
    data['faq_sync']['collection']=cfg.rag.collection
    with pytest.raises(ValidationError,match='분리'):
        type(cfg).model_validate(data)


def test_missing_unchanged_point_prevents_publishing_new_faq(setup):
    env=setup
    before=env.index.apply(refresh(prepare()))
    env.client.delete('faq-managed-test',points_selector=list(before.point_ids),wait=True)
    with pytest.raises(RuntimeError,match='모두 저장'):
        env.index.apply(refresh(prepare(124,answer='다른 FAQ입니다.')))
    assert env.index.current() is before and env.state.read()[0]==1


def test_wrong_vector_direction_prevents_publishing(setup,monkeypatch):
    env=setup
    actual=env.client.upsert
    def wrong_direction(*args,**kwargs):
        for point in kwargs['points']:
            point.vector=[-number for number in point.vector]
        return actual(*args,**kwargs)
    monkeypatch.setattr(env.client,'upsert',wrong_direction)
    with pytest.raises(ValueError,match='방향'):
        env.index.apply(refresh(prepare()))
    assert env.index.current().generation==0


def test_qdrant_acknowledged_but_not_completed_is_not_published(setup,monkeypatch):
    env=setup
    monkeypatch.setattr(env.client,'upsert',lambda **kwargs:SimpleNamespace(status=models.UpdateStatus.ACKNOWLEDGED))
    with pytest.raises(RuntimeError,match='완료되지'):
        env.index.apply(refresh(prepare()))
    assert env.state.read()[0]==0


def test_default_large_dimension_vector_roundtrip_uses_no_api():
    client=QdrantClient(':memory:')
    try:
        client.create_collection('large-test',vectors_config=models.VectorParams(size=3072,distance=models.Distance.COSINE))
        source=prepare().source
        faq=prepare_faq_documents(source,chunk_size=800,chunk_overlap=50,
            embedding_model='text-embedding-3-large',dimensions=3072)
        vectors=QdrantFaqVectors(client,collection='large-test',dimensions=3072)
        vector=Embeddings(3072).vector(faq.chunks[0].embedding_text)
        vectors.stage([(faq.chunks[0],vector)])
        found=vectors.search(vector,faq.chunks)
        assert len(found)==1 and found[0][0].page_content==faq.chunks[0].content
        assert math.isclose(found[0][1],1,abs_tol=1e-6)
    finally:
        client.close()
