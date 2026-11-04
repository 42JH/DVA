"""실제 삭제·실패 복구·삭제와 겹치는 검색/쓰기. 외부 서버를 호출하지 않는다."""

import threading
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from qdrant_client import models

from test_faq_index import setup, prepare, refresh


def test_bulk_delete_cleans_old_current_and_failed_staged_versions(setup,monkeypatch):
    env=setup
    env.index.apply(refresh(prepare()))
    env.index.apply(refresh(prepare(answer='두 번째 판본')))
    actual=env.vectors.stage
    def failed(pairs):
        actual(pairs)
        raise TimeoutError('준비 후 응답 유실')
    monkeypatch.setattr(env.vectors,'stage',failed)
    with pytest.raises(TimeoutError):
        env.index.apply(refresh(prepare(answer='실패한 준비 판본')))
    monkeypatch.setattr(env.vectors,'stage',actual)
    env.index.apply(refresh(prepare(124,answer='삭제할 다른 FAQ'),prepare(125,answer='유지할 FAQ')))
    assert env.client.count('faq-managed-test').count==5
    before=list(env.embeddings.calls)
    result=env.index.apply(refresh(delete_ids=(123,124)))
    assert [faq.faq_id for faq in result.faqs]==['backend-faq:125']
    assert env.client.count('faq-managed-test').count==1 and env.embeddings.calls==before
    assert {row['source'] for row in result.search.search('접수')['all_results']}=={'backend-faq:125'}
    with env.events.connect() as db:
        assert {row[0] for row in db.execute('SELECT faq_id FROM faq_cache_refs')}=={'backend-faq:125'}
        assert db.execute('SELECT count(*) FROM faq_embedding_cache').fetchone()[0]==1


def test_shared_cache_survives_until_last_faq_reference_is_deleted(setup):
    env=setup
    env.index.apply(refresh(prepare(),prepare(124)))
    env.index.apply(refresh(delete_ids=(123,)))
    assert env.state.cached(prepare(124).chunks[0]) is not None
    assert env.client.count('faq-managed-test').count==1
    env.index.apply(refresh(delete_ids=(124,)))
    assert env.state.cached(prepare().chunks[0]) is None


def test_repeated_and_unknown_deletes_are_safe_and_never_embed(setup):
    env=setup
    env.index.apply(refresh(delete_ids=(999,)))
    env.index.apply(refresh(delete_ids=(999,)))
    assert env.embeddings.calls==[] and env.state.read()[1]==()
    assert env.events.blocked_ids()==frozenset({'backend-faq:999'})


def test_delete_rpc_failure_keeps_block_and_does_not_report_cleaned(setup,monkeypatch):
    env=setup
    old=env.index.apply(refresh(prepare()))
    def fail(ids):
        raise TimeoutError('연결 오류')
    monkeypatch.setattr(env.vectors,'delete_faqs',fail)
    with pytest.raises(TimeoutError):
        env.index.apply(refresh(delete_ids=(123,)))
    assert env.events.deletion_status()=={'backend-faq:123':'PENDING'}
    assert env.client.count('faq-managed-test').count==1
    assert env.state.read()[0]==old.generation
    assert old.search.search('접수')['results']==[]


def test_zero_count_and_completed_ack_are_required(setup,monkeypatch):
    env=setup
    env.index.apply(refresh(prepare()))
    original=env.client.delete
    monkeypatch.setattr(env.client,'delete',lambda **kwargs: type('Ack',(),{'status':models.UpdateStatus.COMPLETED})())
    with pytest.raises(RuntimeError,match='남아'):
        env.index.apply(refresh(delete_ids=(123,)))
    monkeypatch.setattr(env.client,'delete',lambda **kwargs: type('Ack',(),{'status':models.UpdateStatus.ACKNOWLEDGED})())
    with pytest.raises(RuntimeError,match='완료되지'):
        env.index.apply(refresh(delete_ids=(123,)))
    assert env.events.deletion_status()['backend-faq:123']=='PENDING'
    monkeypatch.setattr(env.client,'delete',original)
    env.index.apply(refresh(delete_ids=(123,)))
    assert env.events.deletion_status()['backend-faq:123']=='CLEANED'


def test_delete_applied_but_response_lost_is_recovered_on_restart(setup,monkeypatch):
    env=setup
    env.index.apply(refresh(prepare()))
    original=env.vectors.delete_faqs
    def lost(ids):
        original(ids)
        raise TimeoutError('삭제됐지만 응답 유실')
    monkeypatch.setattr(env.vectors,'delete_faqs',lost)
    with pytest.raises(TimeoutError):
        env.index.apply(refresh(delete_ids=(123,)))
    assert env.client.count('faq-managed-test').count==0
    assert env.state.read()[1] and env.events.deletion_status()['backend-faq:123']=='PENDING'
    before=list(env.embeddings.calls)
    monkeypatch.setattr(env.vectors,'delete_faqs',original)
    restarted=env.new_index()
    assert restarted.current().search is None and env.state.read()[1]==()
    assert env.embeddings.calls==before and env.events.deletion_status()['backend-faq:123']=='CLEANED'


def test_delete_commit_failure_can_retry_after_vectors_are_gone(setup,monkeypatch):
    env=setup
    old=env.index.apply(refresh(prepare()))
    original=env.state.commit
    def fail(*args,**kwargs):
        raise OSError('디스크 실패')
    monkeypatch.setattr(env.state,'commit',fail)
    with pytest.raises(OSError):
        env.index.apply(refresh(delete_ids=(123,)))
    assert old.search.search('접수')['results']==[]
    assert env.client.count('faq-managed-test').count==0
    assert env.events.deletion_status()['backend-faq:123']=='PENDING'
    monkeypatch.setattr(env.state,'commit',original)
    env.index.apply(refresh(delete_ids=(123,)))
    assert env.state.read()[1]==() and env.state.cached(prepare().chunks[0]) is None


def test_late_write_is_never_visible_and_reconciliation_removes_it(setup):
    env=setup
    item=prepare()
    old=env.index.apply(refresh(item))
    pair=(item.chunks[0],env.state.cached(item.chunks[0]))
    env.index.apply(refresh(delete_ids=(123,)))
    # 결과가 불명확했던 원격 쓰기가 뒤늦게 나타난 상황을 모사한다.
    env.vectors.stage([pair])
    assert env.client.count('faq-managed-test').count==1
    assert old.search.search('접수')['results']==[]
    env.index.reconcile_deletions()
    assert env.client.count('faq-managed-test').count==0
    env.index.apply(refresh(item))  # 오래된 수정 작업으로도 부활시키지 않는다.
    assert env.client.count('faq-managed-test').count==0


def test_block_received_during_embedding_prevents_late_publish(setup,monkeypatch):
    env=setup
    entered,release=threading.Event(),threading.Event()
    original=env.embeddings.embed_documents
    def waiting(texts):
        entered.set()
        assert release.wait(5)
        return original(texts)
    monkeypatch.setattr(env.embeddings,'embed_documents',waiting)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future=pool.submit(env.index.apply,refresh(prepare()))
        try:
            assert entered.wait(5)
            env.events.block_deletes([123],str(uuid4()))
        finally:
            release.set()
        future.result(timeout=5)
    assert env.client.count('faq-managed-test').count==0
    assert env.index.current().faqs==()
    env.index.apply(refresh(delete_ids=(123,)))
    assert env.state.cached(prepare().chunks[0]) is None


def test_block_during_staging_and_just_before_commit_never_publishes_deleted_faq(setup,monkeypatch):
    env=setup
    original=env.vectors.stage
    def staged_then_blocked(pairs):
        original(pairs)
        env.events.block_deletes([123],str(uuid4()))
    monkeypatch.setattr(env.vectors,'stage',staged_then_blocked)
    env.index.apply(refresh(prepare()))
    assert env.index.current().faqs==()
    monkeypatch.setattr(env.vectors,'stage',original)
    commit=env.state.commit
    def commit_after_block(items,**kwargs):
        env.events.block_deletes([124],str(uuid4()))
        return commit(items,**kwargs)
    monkeypatch.setattr(env.state,'commit',commit_after_block)
    env.index.apply(refresh(prepare(124)))
    assert env.index.current().faqs==()
    monkeypatch.setattr(env.state,'commit',commit)
    env.index.apply(refresh(delete_ids=(123,124)))
    assert env.client.count('faq-managed-test').count==0


def test_completed_search_rows_are_filtered_if_delete_arrives_before_return(setup,monkeypatch):
    env=setup
    old=env.index.apply(refresh(prepare(),prepare(124,answer='남길 내용')))
    original=env.vectors.search
    def search_then_delete(vector,chunks):
        rows=original(vector,chunks)
        env.index.apply(refresh(delete_ids=(123,)))
        return rows
    monkeypatch.setattr(env.vectors,'search',search_then_delete)
    result=old.search.search('접수',top_k=5)
    assert {row['source'] for row in result['all_results']}=={'backend-faq:124'}
    assert all(row['chunk_id'] not in {chunk.point_id for chunk in old.faqs[0].chunks} for row in result['bm25_results'])


def test_delete_during_db_search_retries_survivors_with_one_query_embedding(setup,monkeypatch):
    env=setup
    old=env.index.apply(refresh(prepare(),prepare(124,answer='남길 내용')))
    original=env.vectors.search
    attempts=[]
    def delete_before_search(vector,chunks):
        attempts.append(1)
        if len(attempts)==1:
            env.index.apply(refresh(delete_ids=(123,)))
        return original(vector,chunks)
    monkeypatch.setattr(env.vectors,'search',delete_before_search)
    result=old.search.search('접수',top_k=5)
    assert result['deletion_retries']==1 and len(attempts)==2
    assert len(env.embeddings.queries)==1
    assert {row['source'] for row in result['results']}=={'backend-faq:124'}


def test_final_filter_removes_evidence_captured_before_reranking(setup):
    env=setup
    snap=env.index.apply(refresh(prepare()))
    captured=snap.search.search('접수')['results']
    env.index.apply(refresh(delete_ids=(123,)))
    assert captured and env.index.filter_rows(captured)==[]


def test_unrelated_network_failure_is_not_hidden_by_unrelated_delete(setup,monkeypatch):
    env=setup
    snap=env.index.apply(refresh(prepare()))
    def fail(vector,chunks):
        env.events.block_deletes([999],str(uuid4()))
        raise TimeoutError('무관한 네트워크 장애')
    monkeypatch.setattr(env.vectors,'search',fail)
    with pytest.raises(TimeoutError):
        snap.search.search('접수')
    assert len(env.embeddings.queries)==1


def test_corrupt_deleted_source_does_not_prevent_cleanup(setup):
    env=setup
    env.index.apply(refresh(prepare()))
    with env.events.connect() as db:
        db.execute("UPDATE faq_active_sources SET payload='{}'")
    env.events.block_deletes([123],str(uuid4()))
    restarted=env.new_index()
    assert restarted.current().search is None
    assert env.client.count('faq-managed-test').count==0 and env.state.read()[1]==()
    assert env.events.deletion_status()['backend-faq:123']=='CLEANED'
