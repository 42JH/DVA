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
    && useradd --create-home --uid 10001 appuser
# config/와 prompts/는 기본값으로 넣고, 운영에서는 볼륨으로 덮어써 재빌드 없이 조정한다
COPY --chown=appuser:appuser app ./app
COPY --chown=appuser:appuser config ./config
COPY --chown=appuser:appuser prompts ./prompts
USER appuser
EXPOSE 8000
# 통화 상태가 프로세스 메모리에 있으므로 워커는 1개
CMD ["/app/.venv/bin/uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
