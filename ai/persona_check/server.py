"""시험 묶음 실행 창구: "이 페르소나 글로 이 시나리오들을 돌려 줘"를 받고, 진행 상황과 시나리오별 판정을 돌려준다.
관리자 화면 · 백엔드가 붙는 자리다. 운영 AI 서버와 별도 프로그램으로 띄운다(운영 통화 · 실제 백엔드에 닿지 않는다).

    POST /runs                           {scenarios?: [ID], core?: 핵심만, promptText?: 글, voiceId?: 목소리, concurrency?: 수} → 202 {runId}
    GET  /runs/{runId}                   진행 상황 + 시나리오별 상태 · 판정 요약
    GET  /runs/{runId}/{scenario}/verdict   판정 전체(검사 항목별 정답 · 실제)
    GET  /runs/{runId}/{scenario}/audio     통화 녹음(wav)
    GET  /runs/{runId}/{scenario}/report    한 장 보기(html)
    GET  /scenarios                      시나리오 목록

인증: Authorization: Bearer <PERSONA_CHECK_TOKEN>. 토큰이 없으면 창구를 닫는다(503).
동시 실행: 요청의 concurrency와 PERSONA_CHECK_MAX_CONCURRENCY(기본 1) 중 작은 값. 운영과 OpenAI 계정 한도를 나눠 쓰면 1로 둔다.
묶음마다 logs/persona_check/runs/<runId>/ 에 run.json과 시나리오별 폴더(판정 · 녹음 · 기록)가 남고, 다시 띄워도 조회된다.
MONITOR_USER · MONITOR_PASSWORD를 주면 운영 관제 화면(/monitor)도 띄운다 — 개발 중 눈으로 확인하는 용도.

    # ai/ 폴더에서
    PYTHONPATH=.pydeps PERSONA_CHECK_TOKEN=... CALL_ANALYSIS_OPENAI_API_KEY=... python -m persona_check.server
"""

import asyncio
import hmac
import json
import logging
import os
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from persona_check import judge, try_call

log = logging.getLogger(__name__)
PORT = int(os.environ.get("PERSONA_CHECK_PORT", "8765"))
FILES = {"verdict": "verdict.json", "audio": "call.wav", "report": "report.html"}
RUN_ID = re.compile(r"\d{4}_\d{6}_[0-9a-f]{6}")
MAX_PROMPT_CHARS = 20000  # 운영 페르소나 글 상한(config/server.toml persona_max_prompt_chars)과 같게


class RunRequest(BaseModel):
    scenarios: list[str] | None = Field(None, max_length=200)                 # 없으면 전체(core = true면 핵심만)
    core: bool = False
    promptText: str | None = Field(None, min_length=1, max_length=MAX_PROMPT_CHARS)  # 후보 페르소나 글. 없으면 서버 기본 페르소나
    voiceId: str | None = Field(None, max_length=64)                          # promptText와 함께 줄 때만 쓰인다
    concurrency: int = Field(1, ge=1)


class Runs:
    """시험 묶음들. run_one(시나리오ID, persona, 폴더) → 판정. 테스트는 가짜 run_one을 넣는다."""

    def __init__(self, run_one=None, root: Path | None = None, max_concurrency: int | None = None, bus=None):
        self.root = root or try_call.SAVED / "runs"
        self.max_concurrency = max_concurrency or int(os.environ.get("PERSONA_CHECK_MAX_CONCURRENCY", "1"))
        self.run_one = run_one or (lambda sid, persona, folder: try_call.run_call(sid, persona, bus, folder))
        self.live: dict[str, dict] = {}       # 돌고 있는 묶음(끝나면 내리고 run.json에서 읽는다)
        self.tasks: set[asyncio.Task] = set()
        self.gate: asyncio.Semaphore | None = None  # 묶음이 여러 개여도 동시 통화는 max_concurrency까지

    def start(self, req: RunRequest) -> dict:
        known = {s["id"]: s for s in judge.load_scenarios()}
        ids = req.scenarios or [i for i, s in known.items() if s.get("core") or not req.core]
        if unknown := [i for i in ids if i not in known]:
            raise ValueError(f"모르는 시나리오: {unknown}")
        run = {"runId": f"{datetime.now():%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}", "createdAt": datetime.now().isoformat(timespec="seconds"),
               "status": "running", "candidate": bool(req.promptText), "voiceId": req.voiceId,
               "concurrency": min(req.concurrency, self.max_concurrency), "total": len(ids), "finished": 0,
               "items": [{"scenario": i, "name": known[i].get("name"), "group": known[i].get("group"), "status": "queued",
                          "passed": None, "summary": None, "error": None, "seconds": None, "liveSeconds": None} for i in ids]}
        folder = self.root / run["runId"]
        folder.mkdir(parents=True, exist_ok=True)
        if req.promptText:
            (folder / "persona.md").write_text(req.promptText, encoding="utf-8")
        self.live[run["runId"]] = run
        self._save(run)
        task = asyncio.create_task(self._execute(run, {"promptText": req.promptText, "voiceId": req.voiceId}))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return run

    def get(self, run_id: str) -> dict | None:
        if run_id in self.live:
            return self.live[run_id]
        path = self.root / run_id / "run.json"
        if not RUN_ID.fullmatch(run_id) or not path.is_file():
            return None
        run = json.loads(path.read_text("utf-8"))
        if run["status"] == "running":  # 실행기가 꺼졌다 켜졌다: 그 묶음은 더 진행되지 않는다
            run["status"] = "interrupted"
        return run

    def file(self, run_id: str, scenario: str, kind: str) -> Path | None:
        run = self.get(run_id)
        if not run or kind not in FILES or scenario not in {i["scenario"] for i in run["items"]}:
            return None
        path = self.root / run_id / scenario / FILES[kind]
        return path if path.is_file() else None

    def _save(self, run: dict) -> None:
        (self.root / run["runId"] / "run.json").write_text(json.dumps(run, ensure_ascii=False, indent=1), encoding="utf-8")

    async def _execute(self, run: dict, persona: dict) -> None:
        if self.gate is None:
            self.gate = asyncio.Semaphore(self.max_concurrency)
        gate = asyncio.Semaphore(run["concurrency"])

        async def one(item: dict) -> None:
            async with gate, self.gate:
                item["status"], began = "running", time.monotonic()
                self._save(run)
                try:
                    verdict = await self.run_one(item["scenario"], persona, self.root / run["runId"] / item["scenario"])
                    item.update(status="done", passed=verdict["passed"], summary=verdict["summary"],
                                liveSeconds=verdict.get("liveSeconds"))  # 음성 모델 사용 시간(요금 기준)
                except Exception as e:  # 통화 연결 실패 등: 시나리오 실패가 아니라 시험 자체의 실패
                    log.warning("시험 통화 실패 %s %s: %s", run["runId"], item["scenario"], e)
                    item.update(status="error", error=f"{type(e).__name__}: {e}"[:300])
                item["seconds"] = round(time.monotonic() - began)
                run["finished"] += 1
                self._save(run)

        try:
            await asyncio.gather(*(one(item) for item in run["items"]))
            run["status"] = "done"
        finally:  # 종료로 취소되면 run.json은 running으로 남고, 다음에 읽을 때 interrupted로 보인다
            self._save(run)
            self.live.pop(run["runId"], None)

    async def stop(self) -> None:
        """돌고 있는 통화를 취소하고 끝날 때까지 기다린다(통화마다 세션을 끊고 나온다)."""
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)


def create_app(runs: Runs, monitor: APIRouter | None = None) -> FastAPI:
    """창구 앱. monitor = 개발 확인용 관제 라우터(자체 HTTP Basic 인증이라 토큰 인증 밖에 붙인다)."""
    def auth(authorization: str = Header(default="")) -> None:
        token = os.environ.get("PERSONA_CHECK_TOKEN", "")
        if not token:
            raise HTTPException(503, "PERSONA_CHECK_TOKEN이 설정되지 않음")
        if not hmac.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
            raise HTTPException(401, "인증 실패")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        yield
        await runs.stop()  # 창구가 내려갈 때 음성 세션을 남기지 않는다

    api = APIRouter(dependencies=[Depends(auth)])

    @api.get("/scenarios")
    async def list_scenarios() -> list[dict]:
        return [{"id": s["id"], "name": s.get("name"), "group": s.get("group"), "core": bool(s.get("core"))}
                for s in judge.load_scenarios()]

    @api.post("/runs", status_code=202)
    async def start(req: RunRequest) -> dict:
        try:
            return {"runId": runs.start(req)["runId"]}
        except ValueError as e:
            raise HTTPException(422, str(e)) from None

    @api.get("/runs/{run_id}")
    async def status(run_id: str) -> dict:
        if (run := runs.get(run_id)) is None:
            raise HTTPException(404, "없는 시험 묶음")
        return run

    @api.get("/runs/{run_id}/{scenario}/{kind}")
    async def result(run_id: str, scenario: str, kind: str) -> FileResponse:
        if (path := runs.file(run_id, scenario, kind)) is None:
            raise HTTPException(404, "없는 결과")
        return FileResponse(path)

    app = FastAPI(title="persona check", lifespan=lifespan)
    app.include_router(api)
    if monitor is not None:
        app.include_router(monitor)
    return app


def main() -> None:
    import uvicorn

    bus = monitor = None
    if os.environ.get("MONITOR_USER"):  # 개발 확인용 관제 화면
        from monitor import Bus, create_monitor_router
        bus = Bus()
        monitor = create_monitor_router(try_call.all_calls, bus)
    uvicorn.run(create_app(Runs(bus=bus), monitor), host=os.environ.get("PERSONA_CHECK_HOST", "127.0.0.1"), port=PORT,
                log_level="warning")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "WARNING"), stream=sys.stdout, format="%(message)s")
    logging.getLogger("persona_check").setLevel(logging.INFO)  # 대화와 판정은 보이게, 운영 코드의 로그는 경고부터
    main()
