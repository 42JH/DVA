FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime@sha256:c16f4c749e2d9e96878875cdf6cc45cddda1d1a36fddd371dd6f2360f1b6e2a2
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HF_HOME=/models HF_HUB_OFFLINE=1 TOKENIZERS_PARALLELISM=false
COPY gpu/requirements-container.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
    && useradd --uid 10001 --create-home reranker
COPY --chown=reranker:reranker app/__init__.py ./app/__init__.py
COPY --chown=reranker:reranker app/rag/__init__.py app/rag/gpu.py app/rag/qwen.py ./app/rag/
USER reranker
EXPOSE 8001
HEALTHCHECK --interval=15s --timeout=3s --start-period=120s --retries=4 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health',timeout=2).read()"
CMD ["uvicorn", "app.rag.gpu:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1", "--no-access-log"]
