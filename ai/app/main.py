from fastapi import FastAPI

app = FastAPI(title="Dva AI Agent")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-agent"}
