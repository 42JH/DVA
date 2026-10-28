"""외부 GPU VM/RunPod의 Qwen 리랭킹 API. 전화 서버에는 torch가 필요 없다."""

import asyncio
import hmac
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.rag.qwen import MODEL, REVISION, QwenReranker


class RerankDocument(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    chunk_id: str = Field(min_length=1, max_length=128)
    content: str = Field(min_length=1, max_length=12000)


class RerankRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    question: str = Field(min_length=1, max_length=500)
    documents: list[RerankDocument] = Field(min_length=1, max_length=5)

    @model_validator(mode='after')
    def unique(self):
        if len({d.chunk_id for d in self.documents}) != len(self.documents):
            raise ValueError('문서 ID가 중복됩니다.')
        return self


def create_gpu_app(predictor=None):
    lock = threading.Lock()
    model = predictor

    @asynccontextmanager
    async def lifespan(app):
        nonlocal model
        if not os.getenv('RAG_RERANKER_API_KEY'):
            raise RuntimeError('RAG_RERANKER_API_KEY가 필요합니다.')
        if model is None:
            from huggingface_hub import snapshot_download
            snapshot = await asyncio.to_thread(snapshot_download, MODEL, revision=REVISION,
                local_files_only=True, cache_dir=os.getenv('HF_HOME'))
            if Path(snapshot).name != REVISION:
                raise RuntimeError('고정 revision의 다운로드를 확인하세요.')
            model = await asyncio.to_thread(QwenReranker, snapshot, 'float16', 1024)
            await asyncio.to_thread(model.predict, [('포장은 어떻게 하나요?', '고객이 직접 포장해 주세요.')])
        yield

    app = FastAPI(title='FAQ Qwen 리랭커', lifespan=lifespan)

    @app.get('/health')
    def health():
        return {'status': 'ok' if model is not None else 'starting', 'model': MODEL, 'revision': REVISION}

    @app.post('/rerank')
    async def rerank(body: RerankRequest, authorization: str | None = Header(default=None)):
        expected = 'Bearer '+os.getenv('RAG_RERANKER_API_KEY', '')
        if not os.getenv('RAG_RERANKER_API_KEY') or not hmac.compare_digest((authorization or '').encode(), expected.encode()):
            raise HTTPException(401, detail='인증 실패')
        def infer():
            # HTTP 취소 뒤에도 GPU 작업은 계속될 수 있으므로 스레드 내부에서 잠근다.
            with lock:
                return model.predict([(body.question, doc.content) for doc in body.documents])
        try:
            scores = await asyncio.to_thread(infer)
        except ValueError:
            raise HTTPException(422, detail='원문이 모델 입력 한도를 넘습니다. 자동으로 자르지 않습니다.') from None
        return {'model': MODEL, 'revision': REVISION, 'results': [
            {'chunk_id': doc.chunk_id, 'score': float(score)}
            for doc, score in zip(body.documents, scores, strict=True)]}
    return app


app = create_gpu_app()
