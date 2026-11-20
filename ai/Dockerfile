# AI 서버 이미지(원본 ai/Dockerfile 기준). 새 서버 app/main.py를 띄운다.
# RAG(app/rag/, manuals/, config/rag-*.json)는 원본 그대로다(다른 담당자 구현, 수정 금지).
FROM python:3.14-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.28 /uv /bin/uv
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev \
    && useradd --create-home --uid 10001 appuser \
    && mkdir -p /app/rag_state /app/state /app/logs/calls \
    && chown -R appuser:appuser /app/rag_state /app/state /app/logs \
    && chmod 700 /app/rag_state /app/state
# config/와 prompts/는 기본값으로 넣고, 운영에서는 볼륨으로 덮어써 재빌드 없이 조정한다(원본과 같음)
COPY --chown=appuser:appuser app ./app
COPY --chown=appuser:appuser config ./config
COPY --chown=appuser:appuser prompts ./prompts
COPY --chown=appuser:appuser manuals ./manuals
COPY --chown=appuser:appuser scripts/bootstrap_faq.py ./scripts/bootstrap_faq.py
COPY --chown=appuser:appuser pbx_webhook ./pbx_webhook
COPY --chown=appuser:appuser backend_client ./backend_client
COPY --chown=appuser:appuser policy ./policy
# 첫 전화에서 토크나이저 파일을 받지 않도록 빌드 때 준비한다(원본과 같음).
ENV TIKTOKEN_CACHE_DIR=/app/tokenizer_cache
RUN /app/.venv/bin/python -c "import tiktoken; tiktoken.get_encoding('o200k_base'); tiktoken.get_encoding('cl100k_base')" \
    && chmod -R a+rX /app/tokenizer_cache
USER appuser
EXPOSE 8000
# 통화 상태가 프로세스 메모리에 있으므로 워커는 1개(decisions.md P3)
CMD ["/app/.venv/bin/python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
