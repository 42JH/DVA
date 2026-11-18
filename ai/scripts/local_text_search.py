"""텍스트 실험 전용 실제 검색 어댑터. 원격 GPU·전화 서버에는 연결하지 않는다."""

import asyncio
import hashlib
import json
import os
import queue
import subprocess
import threading
from pathlib import Path
from time import perf_counter

from app.rag.context import build_search_context
from app.rag.prompts import RagContextRenderer
from app.rag.schemas import Evidence


AI_DIR = Path(__file__).resolve().parent.parent


class LocalQwenProcess:
    def __init__(self, python: Path):
        self.messages = queue.Queue()
        self.process = subprocess.Popen(
            [str(python), '-m', 'scripts.local_qwen_worker', '--model-info',
             str(AI_DIR / 'data/private/qwen-reranker/model.json')],
            cwd=AI_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding='utf-8', bufsize=1,
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8', 'HF_HUB_OFFLINE': '1'},
        )
        def read_lines():
            for line in self.process.stdout:
                self.messages.put(line)
            self.messages.put(None)
        threading.Thread(target=read_lines, daemon=True).start()
        try:
            self.info = self._read(180)
            if self.info.get('ready') is not True:
                raise RuntimeError('로컬 Qwen을 준비하지 못했습니다.')
        except BaseException:
            self.close()
            raise

    def _read(self, timeout):
        try:
            line = self.messages.get(timeout=timeout)
        except queue.Empty:
            self.close()
            raise TimeoutError('로컬 Qwen 응답 시간 초과') from None
        if line is None:
            raise RuntimeError('로컬 Qwen 프로세스가 종료됐습니다.')
        return json.loads(line)

    def rerank(self, question, documents):
        self.process.stdin.write(json.dumps({'question': question, 'documents': documents}, ensure_ascii=False)+'\n')
        self.process.stdin.flush()
        result = self._read(60)
        if 'error_type' in result:
            raise RuntimeError('로컬 Qwen 재정렬에 실패했습니다.')
        return result

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout):
            if stream:
                stream.close()


class LocalTextSearch:
    def __init__(self, qwen_python: Path, collection='manuals_dev_openai_large'):
        from qdrant_client import QdrantClient, models
        from langchain_openai import OpenAIEmbeddings
        from langchain_qdrant import QdrantVectorStore
        from scripts.evaluate_bm25 import faq_documents
        from scripts.search_hybrid import load_faq_documents, HybridSearchExperiment
        from scripts.search_descriptions import load_descriptions

        self.client = QdrantClient(url=os.getenv('QDRANT_URL', 'http://127.0.0.1:6333'),
                                  api_key=os.environ['QDRANT_API_KEY'], timeout=30)
        self.qwen = None
        started = perf_counter()
        try:
            config = self.client.get_collection(collection).config.params.vectors
            if not isinstance(config, models.VectorParams) or config.size != 3072 or config.distance != models.Distance.COSINE:
                raise ValueError('3072차원 Cosine large 컬렉션이 필요합니다.')
            documents = load_faq_documents(self.client, collection)
            source = AI_DIR / 'manuals/delivery_faq.md'
            raw = source.read_bytes()
            local_docs = faq_documents(raw.decode('utf-8'), source)
            if {d.metadata['chunk_id']: d.page_content for d in documents} != {d.metadata['chunk_id']: d.page_content for d in local_docs}:
                raise ValueError('로컬 원문과 DB의 FAQ가 다릅니다.')
            descriptions_path = AI_DIR / 'config/rag-search-descriptions.json'
            descriptions = load_descriptions(descriptions_path, raw, documents)
            embeddings = OpenAIEmbeddings(model='text-embedding-3-large', request_timeout=30, max_retries=1)
            store = QdrantVectorStore(client=self.client, collection_name=collection,
                                     embedding=embeddings, validate_collection_config=False)
            condition = models.Filter(must=[models.HasIdCondition(has_id=[d.metadata['_id'] for d in documents])])
            self.search = HybridSearchExperiment(
                documents, embeddings.embed_query,
                lambda vector: store.similarity_search_with_score_by_vector(vector, k=len(documents), filter=condition),
                bm25_weight=.4, c=60, descriptions=descriptions, expected_dimensions=3072,
            )
            self.renderer = RagContextRenderer()
            self.qwen = LocalQwenProcess(qwen_python)
            self.lock = asyncio.Lock()
            self.worker_lock = threading.Lock()
            self.info = {'collection': collection, 'embedding_model': 'text-embedding-3-large',
                         'bm25_weight': .4, 'dense_weight': .6, 'c': 60, 'candidate_k': 5, 'context_k': 3,
                         'faq_count': len(documents), 'source_sha256': hashlib.sha256(raw).hexdigest(),
                         'descriptions_sha256': hashlib.sha256(descriptions_path.read_bytes()).hexdigest(),
                         'reranker': self.qwen.info, 'startup_seconds': perf_counter()-started}
        except BaseException:
            self.close()
            raise

    def _search(self, question):
        # asyncio 취소는 이미 시작된 스레드를 멈추지 않는다. 실제 프로세스 통신도 잠근다.
        with self.worker_lock:
            return self._search_unlocked(question)

    def _search_unlocked(self, question):
        started = perf_counter()
        found = self.search.search(question, top_k=5)
        # 로컬 절대 경로 대신 원문과 안정적인 ID를 전달한다.
        candidates = [{key: value for key, value in row.items() if key != 'source'} for row in found['results']]
        ranked = self.qwen.rerank(question, candidates)
        context = build_search_context(question, [Evidence(
            chunk_id=row['chunk_id'], source_id='delivery_faq', title=row['title'],
            content=row['context'], reranker_score=row['reranker_score'],
        ) for row in ranked['results']])
        return {'tool_output': {'ok': True, 'context_text': self.renderer.render(context)},
                'evidence': context.llm_payload()['evidence'], 'rrf_candidates': candidates,
                'bm25_results': found['bm25_results'],
                'dense_results': [{key: value for key, value in row.items() if key != 'source'}
                                  for row in sorted(found['all_results'], key=lambda row: row['dense_rank'])],
                'reranked': ranked['results'], 'search_timings': found['timings'],
                'reranking_seconds': ranked['seconds'], 'retrieval_seconds': perf_counter()-started}

    async def __call__(self, question):
        # 단일 GPU 프로세스의 요청·응답 대응을 보장한다. LLM 대기는 동시 처리할 수 있다.
        async with self.lock:
            return await asyncio.to_thread(self._search, question)

    def close(self):
        if self.qwen is not None:
            self.qwen.close()
        self.client.close()
