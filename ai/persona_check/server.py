"""시험 묶음 실행 창구: "이 페르소나 글로 이 시나리오들을 돌려 줘"를 받고, 진행 상황과 시나리오별 판정을 돌려준다.
관리자 화면 · 백엔드가 붙는 자리다. 운영 AI 서버와 별도 프로그램으로 띄운다(운영 통화 · 실제 백엔드에 닿지 않는다).

    POST /runs                           {scenarios?: [ID], core?: 핵심만, promptText?: 글, voiceId?: 목소리, concurrency?: 수} → 202 {runId}
    POST /runs/{runId}/stop              시험 멈춤: 돌던 통화를 끊고 남은 시나리오는 걸지 않는다 → 202 {runId}. 이미 끝난 묶음도 202(두 번 눌러도 같음)
    GET  /runs/{runId}                   진행 상황 + 시나리오별 상태 · 판정 요약
    GET  /runs/{runId}/{scenario}/verdict   판정 전체(검사 항목별 정답 · 실제)
    GET  /runs/{runId}/{scenario}/record    통화 기록: 고객이 한 말 · 고른 행동(customer), 백엔드가 받은 통화 이벤트 · 초안 · 분석(received)
    GET  /runs/{runId}/{scenario}/audio     통화 녹음(wav, 고객과 AI를 섞은 모노)
    GET  /runs/{runId}/{scenario}/report    한 장 보기(html)
    GET  /scenarios                      시나리오 목록(available = 이 환경에서 돌릴 수 있는가)

인증: Authorization: Bearer <PERSONA_CHECK_TOKEN>. 토큰이 없으면 창구를 닫는다(503).
동시 실행: 요청의 concurrency와 PERSONA_CHECK_MAX_CONCURRENCY(기본 1) 중 작은 값. 운영과 OpenAI 계정 한도를 나눠 쓰면 1로 둔다.
묶음마다 logs/persona_check/runs/<runId>/ 에 run.json과 시나리오별 폴더(판정 · 녹음 · 기록)가 남고, 다시 띄워도 조회된다.

    # ai/ 폴더에서
    PYTHONPATH=.pydeps PERSONA_CHECK_TOKEN=... PERSONA_CHECK_OPENAI_API_KEY=... python -m persona_check.server
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
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from persona_check import judge, try_call

log = logging.getLogger(__name__)
PORT = int(os.environ.get("PERSONA_CHECK_PORT", "8765"))
FILES = {"verdict": "verdict.json", "record": "backend.json", "audio": "call.wav", "report": "report.html"}
# 형식을 정해 보낸다: Python 3.14는 .wav를 audio/vnd.wave로 짐작하고, 백엔드 중계는 audio/wav · audio/x-wav만 받아 녹음이 안 들렸다(11/12 서버 첫 시험)
MEDIA = {"verdict": "application/json", "record": "application/json", "audio": "audio/wav", "report": "text/html; charset=utf-8"}
RUN_ID = re.compile(r"\d{4}_\d{6}_[0-9a-f]{6}")
MAX_PROMPT_CHARS = 20000  # 운영 페르소나 글 상한(config/server.toml persona_max_prompt_chars)과 같게


class RunRequest(BaseModel):
    scenarios: list[str] | None = Field(None, min_length=1, max_length=200)   # 없으면 전체(core = true면 핵심만). 빈 목록은 422
    core: bool = False
    promptText: str | None = Field(None, min_length=1, max_length=MAX_PROMPT_CHARS)  # 후보 페르소나 글. 없으면 서버 기본 페르소나
    voiceId: str | None = Field(None, max_length=64)                          # promptText와 함께 줄 때만 쓰인다
    concurrency: int = Field(1, ge=1)
    tag: str | None = Field(None, min_length=1, max_length=64)                # 화면이 붙이는 표시(어느 상담가 버전의 시험인지). 창구는 뜻을 모르고 저장 · 조회만 한다


class Busy(Exception):
    """같은 표시(tag)의 묶음이 아직 돌고 있다. 받으면 같은 통화가 두 번 걸려 요금이 두 번 나간다."""


def available(scenario: dict) -> bool:
    """이 환경에서 돌릴 수 있는 시나리오인가. FAQ가 필요한 시나리오는 검색 서버가 연결돼 있어야 한다."""
    return scenario.get("needs") != "faq" or try_call.faq_connected()


class Runs:
    """시험 묶음들. run_one(시나리오ID, persona, 폴더) → 판정. 테스트는 가짜 run_one을 넣는다."""

    def __init__(self, run_one=None, root: Path | None = None, max_concurrency: int | None = None):
        self.root = root or try_call.SAVED / "runs"
        self.max_concurrency = max_concurrency or int(os.environ.get("PERSONA_CHECK_MAX_CONCURRENCY", "1"))
        self.run_one = run_one or (lambda sid, persona, folder: try_call.run_call(sid, persona, out_dir=folder))
        self.live: dict[str, dict] = {}       # 돌고 있는 묶음(끝나면 내리고 run.json에서 읽는다)
        self.tasks: set[asyncio.Task] = set()
        self.task_of: dict[str, asyncio.Task] = {}  # 돌고 있는 묶음의 실행 태스크(멈춤 요청이 찾는다)
        self.gate: asyncio.Semaphore | None = None  # 묶음이 여러 개여도 동시 통화는 max_concurrency까지

    def start(self, req: RunRequest) -> dict:
        if req.tag and any(r.get("tag") == req.tag and r["status"] == "running" for r in self.live.values()):
            raise Busy(f"이 표시의 시험이 이미 돌고 있음: {req.tag}")
        known = {s["id"]: s for s in judge.load_scenarios()}
        ids = req.scenarios or [i for i, s in known.items() if (s.get("core") or not req.core) and available(s)]
        if unknown := [i for i in ids if i not in known]:
            raise ValueError(f"모르는 시나리오: {unknown}")
        if blocked := [i for i in ids if not available(known[i])]:
            raise ValueError(f"이 환경에서 돌릴 수 없는 시나리오(FAQ 검색 서버 미연결): {blocked}")
        run = {"runId": f"{datetime.now():%m%d_%H%M%S}_{uuid.uuid4().hex[:6]}", "createdAt": datetime.now().isoformat(timespec="milliseconds"),
               "status": "running", "candidate": bool(req.promptText), "voiceId": req.voiceId, "tag": req.tag,
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
        self.task_of[run["runId"]] = task
        task.add_done_callback(self.tasks.discard)
        return run

    def cancel(self, run_id: str) -> dict | None:
        """관리자의 멈춤. 상태를 stopped로 바꾸고 실행 태스크를 취소한다 — 돌던 통화는 세션을 끊고 나오고(run_call의 finally),
        줄 서 있던 시나리오는 걸지 않는다. 끝나지 않은 항목은 queued · running으로 남고 화면은 그것을 '시험 안 함'으로 본다(남은 것 시험으로 다시 돌림).
        끊는 데 몇 초 걸려도 기다리지 않는다(백엔드 중계 시한 8초). 상태가 먼저 바뀌므로 같은 버전의 새 시험은 바로 받는다."""
        run = self.get(run_id)
        if run and (task := self.task_of.get(run_id)) and run["status"] == "running":
            run["status"] = "stopped"
            self._save(run)
            task.cancel()
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

    def recent(self, tag: str | None = None) -> list[dict]:
        """묶음 목록(최신순). tag를 주면 그 표시가 붙은 묶음만. 화면이 버전마다 시나리오별 최신 결과를 모을 때 쓴다.
        shortcut: 부를 때마다 run.json을 전부 읽는다. 묶음이 수천 개가 되면 목록 파일을 따로 두거나 개수 제한을 건다."""
        found = [run for path in self.root.glob("*/run.json") if (run := self.get(path.parent.name))]
        return sorted((r for r in found if tag is None or r.get("tag") == tag),
                      key=lambda r: (r["createdAt"], r["runId"]), reverse=True)

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

        # 운영 FAQ 저장 파일을 묶음마다 한 번 복사해 이 묶음의 통화가 함께 쓴다(시작 시점의 FAQ로 시험)
        faq = self.root / run["runId"] / try_call.FAQ_SNAPSHOT
        if source := os.environ.get("PERSONA_CHECK_FAQ_DB"):
            await asyncio.to_thread(try_call.snapshot_faq, Path(source), faq)
        try:
            await asyncio.gather(*(one(item) for item in run["items"]))
            run["status"] = "done"
        finally:  # 창구 종료로 취소되면 run.json은 running으로 남고, 다음에 읽을 때 interrupted로 보인다. 멈춤은 stopped
            self._save(run)
            self.live.pop(run["runId"], None)
            self.task_of.pop(run["runId"], None)
            faq.unlink(missing_ok=True)

    async def stop(self) -> None:
        """돌고 있는 통화를 취소하고 끝날 때까지 기다린다(통화마다 세션을 끊고 나온다)."""
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)


def create_app(runs: Runs) -> FastAPI:
    """창구 앱."""
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
        return [{"id": s["id"], "name": s.get("name"), "group": s.get("group"), "core": bool(s.get("core")),
                 "available": available(s)} for s in judge.load_scenarios()]

    @api.get("/scenarios/{scenario_id}")
    async def scenario_detail(scenario_id: str) -> dict:
        """시나리오 한 개의 내용(화면의 시나리오 보기): 고객 대본 · 정답 · 행동 확인.
        정답은 판정기를 통화 기록 없이 돌려 얻는다 — 이름과 값이 판정 결과표와 늘 같다."""
        scenario = {s["id"]: s for s in judge.load_scenarios()}.get(scenario_id)
        if scenario is None:
            raise HTTPException(404, "없는 시나리오")
        who = scenario.get("customer")
        checks = judge.judge(scenario, {"caller": scenario.get("caller", "")})["checks"]
        return {"id": scenario["id"], "name": scenario.get("name"), "group": scenario.get("group"),
                "core": bool(scenario.get("core")), "available": available(scenario),
                "caller": f"등록 고객 {who['name']}" if who else "신규 고객",
                "lines": [{"text": line["text"], "optional": bool(line.get("optional"))} for line in scenario["lines"]],
                "expected": [{"name": c["name"], "value": c["expected"]} for c in checks if c["name"] != "대본 진행"],
                "checks": scenario.get("checks", [])}

    @api.get("/runs")
    async def recent(tag: str | None = None) -> list[dict]:
        return runs.recent(tag)

    @api.post("/runs", status_code=202)
    async def start(req: RunRequest) -> dict:
        try:
            return {"runId": runs.start(req)["runId"]}
        except ValueError as e:
            raise HTTPException(422, str(e)) from None
        except Busy as e:
            raise HTTPException(409, str(e)) from None

    @api.post("/runs/{run_id}/stop", status_code=202)
    async def stop_run(run_id: str) -> dict:
        if runs.cancel(run_id) is None:
            raise HTTPException(404, "없는 시험 묶음")
        return {"runId": run_id}

    @api.get("/runs/{run_id}")
    async def status(run_id: str) -> dict:
        if (run := runs.get(run_id)) is None:
            raise HTTPException(404, "없는 시험 묶음")
        return run

    @api.get("/runs/{run_id}/{scenario}/{kind}")
    async def result(run_id: str, scenario: str, kind: str) -> Response:
        if (path := runs.file(run_id, scenario, kind)) is None:
            raise HTTPException(404, "없는 결과")
        log_path = path.with_name("call.json")
        if kind == "record" and log_path.is_file():
            # AI 통화 로그(call.json — 운영 AI가 통화마다 남기는 JSON 로그와 같은 모양)를 callLog로 붙인다.
            # 백엔드 중계는 record까지만 넘겨서, AI 파트가 브라우저로 …/record 주소를 열면 로그까지 보게(11/12). 화면은 이 칸을 안 씀
            record = json.loads(path.read_text("utf-8"))
            return JSONResponse(record | {"callLog": json.loads(log_path.read_text("utf-8"))})
        return FileResponse(path, media_type=MEDIA[kind])

    app = FastAPI(title="persona check", lifespan=lifespan)
    app.include_router(api)
    return app


def main() -> None:
    import uvicorn

    uvicorn.run(create_app(Runs()), host=os.environ.get("PERSONA_CHECK_HOST", "127.0.0.1"), port=PORT,
                log_level="warning")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "WARNING"), stream=sys.stdout, format="%(message)s")
    logging.getLogger("persona_check").setLevel(logging.INFO)  # 대화와 판정은 보이게, 운영 코드의 로그는 경고부터
    main()
