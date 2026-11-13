"""시험 통화 실행기: 가짜 고객이 운영과 같은 통화 로직에 전화를 걸고, 끝나면 판정까지 남긴다.

    가짜 고객(시나리오 대본에서 지금 할 문장을 고름 → 문장별 TTS 음성) ──WebRTC──> GPT-Live 세션
    운영 통화 로직(app/: CallService · LiveFlow · 결과 전송) ──sideband──> 같은 세션   (운영과 같은 붙는 방식)
    백엔드 = 메모리 가짜 BE(MockBackend) — 실제 주문 · 고객 · 통계에 닿지 않는다

운영 코드는 고치지 않고 불러다 쓴다. 다른 점은 입구뿐이다: 전화(SIP)는 걸려 온 세션을 accept로 설정하는데, 여기서는 그 설정을
가로챈 뒤(intercept · capture) 같은 설정으로 WebRTC 세션을 직접 만들고 accept를 통과시킨다.
기본 WebSocket으로 만든 세션에는 sideband가 붙지 않는다(503, 11/11 확인) — 그래서 WebRTC다(aiortc 필요).
주소: 주소DB · 카카오 키가 없는 환경에서는 지번 · 우편번호를 고정값으로 채운다(fake_geo) — 없으면 운영 코드가 주문을 미완료로 처리한다.
매뉴얼 검색: QDRANT_URL이 있으면 운영과 같은 RagService를 붙인다. 없으면 붙이지 않고, FAQ가 필요한 시나리오(needs = "faq")는 돌리지 않는다.

    # ai/ 폴더에서 한 통(여러 통 · 화면 연동 창구는 persona_check/server.py)
    PYTHONPATH=.pydeps PERSONA_CHECK_OPENAI_API_KEY=키 python -m persona_check.try_call [시나리오ID] [페르소나.md]

통화마다 폴더 하나(기본 logs/persona_check/<날짜_시각>/):
    backend.json  가짜 백엔드가 받은 것 + 고객이 한 말(판정기 입력)      verdict.json  판정
    call.wav      녹음(고객과 AI를 섞은 모노)      call.json  운영 통화 기록과 같은 내용      report.html  한 장 보기
"""

import asyncio
import fractions
import hashlib
import html
import json
import logging
import os
import shutil
import sqlite3
import sys
import tempfile
import time
import wave
from datetime import datetime, timezone
from functools import partial
from pathlib import Path

import openai

try:
    import numpy as np
    from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription
    from aiortc.mediastreams import MediaStreamError
    from av import AudioFrame
except ImportError:  # WebRTC 라이브러리가 없는 곳(CI): 통화는 못 걸지만 조립(build · capture)과 시나리오 점검은 된다
    np = RTCPeerConnection = RTCSessionDescription = AudioFrame = None
    MediaStreamTrack, MediaStreamError = object, Exception

from app.address.gazetteer import open_db
from app.calls.live import LiveFlow
from app.calls.results import ResultService
from app.calls.service import CallDeps, CallService
from app.config import ROOT, load_server_config
from app.domain.fare import parcel_fare
from app.domain.state import Geo
from app.integrations import kakao
from app.integrations.address import AddressService
from app.integrations.backend.gateway import BackendGateway
from app.persistence.outbox import Outbox
from app.policy.model import load_policy
from backend_client.mock import MockBackend
from backend_client.order import Geo as PlaceGeo, Place
from pbx_webhook.incoming import IncomingCall
from persona_check import customer, judge
from persona_check.judge import SILENT

log = logging.getLogger(__name__)
TTS_MODEL, TTS_VOICE = "gpt-4o-mini-tts", "ash"
RATE, SAMPLES = 24000, 480           # TTS가 주는 PCM16 모노 24kHz를 20ms씩 보낸다
MAX_SEC, STUCK_SEC = 330, 20         # 통화 길이 상한(시나리오의 max_sec로 줄인다) · AI가 이만큼 조용하면 고객이 "여보세요?"
MAX_REPEAT = 3                       # 같은 대본 문장을 이만큼 말하고도 또 고르면 통화를 접는다(맴도는 통화의 비용 상한)
MAX_HELLO = 3                        # "여보세요?"를 이만큼 잇달아 하고도 진행이 없으면 통화를 접는다(11/12: AI가 멈춘 통화가 5분을 다 썼다)
STALL_SEC = 60                       # 고객이 새 말을 하지 못한 채 이만큼 지나면 통화를 접는다(11/12: 같은 질문이 맴돈 통화가 5분을 썼다)
CALL_TIMEOUT_SEC = 30.0              # TTS 한 번을 기다리는 시간
GAP_DONE, GAP_MID = 1.5, 4.0         # AI 말이 문장으로 끝났으면 1.5초, 중간에 멈춘 것 같으면 4초 기다렸다가 고객이 말한다
VOICE_RMS = 250                      # 받은 소리가 이보다 크면 AI가 말하는 중
SAVED = ROOT / "logs" / "persona_check"
TTS_DIR = SAVED / "tts"              # 문장별 고객 음성. 한 번 만들어 계속 쓴다 → 통화마다 같은 소리
CONFIG_ID = "persona-check-config"   # 세션 설정만 가로채는 가짜 통화의 이름
FAQ_SNAPSHOT = "faq-events.sqlite3"  # 시험 묶음 폴더에 두는 운영 FAQ 저장 파일의 복사본(묶음이 끝나면 지운다)
LIVE: list = []                      # 지금 통화 중인 CallService(개발용 관제 목록)


def seed(mock: MockBackend, scenario: dict) -> None:
    """시나리오의 고객 조건을 가짜 백엔드에 심는다: 등록 고객이면 이름 · 기본 발송 주소 · 주소록 · 기존 주문."""
    c, caller = scenario.get("customer"), scenario["caller"]
    if not c:
        return

    def place(name: str, phone: str, address: str, detail: str) -> Place:
        g = fake_geo(address)
        return Place(name=name, phone=phone, address=address, address_detail=detail,
                     geo=PlaceGeo(jibun_address=g.jibun_address, dong_name=g.dong_name, postal_code=g.postal_code))

    mock.add_customer(caller, c["name"], default_origin=place(c["name"], caller, c["address"], c.get("detail", "")),
                      pins=[place(p["name"], p["phone"], p["address"], p.get("detail", "")) for p in scenario.get("pins") or []])
    for order in scenario.get("orders") or []:
        mock.add_order(caller, order["status"], [(order["receiver"], order["address"])])


def fake_geo(address: str | None) -> Geo | None:
    """시험용 주소 정보. 운영 코드는 지번 · 우편번호가 없으면 주문을 미완료로 처리한다(outcome.ADDRESS_GEO_MISSING).
    ponytail: 주소 인식이 맞는지는 이걸로 검증되지 않는다. 주소DB나 카카오 키가 있는 환경에서는 쓰지 않는다(run_call이 가린다)."""
    if not address:
        return None
    area = judge.area(address) or "시험동"   # 되읽기("○○에서 ○○의 …")가 주소와 맞게 들리도록 구 이름을 쓴다
    return Geo(f"{area} 1-1", area, "06236")


class Proxy:
    """몇 개 속성만 바꿔 끼운 객체."""

    def __init__(self, real, **over):
        self._real, self._over = real, over

    def __getattr__(self, name):
        return self._over[name] if name in self._over else getattr(self._real, name)


class CustomerTrack(MediaStreamTrack):
    """전화선처럼 쉬지 않고 보내는 고객 음성(말이 없으면 무음)."""
    kind = "audio"

    def __init__(self):
        super().__init__()
        self.queue, self.pts, self.t0 = bytearray(), 0, None
        self.sent = bytearray()  # 보낸 소리 전체(녹음용)

    async def recv(self):
        if self.t0 is None:
            self.t0 = time.monotonic()
        await asyncio.sleep(max(0, self.t0 + self.pts / RATE - time.monotonic()))
        chunk = bytes(self.queue[:SAMPLES * 2])
        del self.queue[:SAMPLES * 2]
        chunk += bytes(SAMPLES * 2 - len(chunk))
        self.sent.extend(chunk)
        frame = AudioFrame(format="s16", layout="mono", samples=SAMPLES)
        frame.planes[0].update(chunk)
        frame.sample_rate, frame.pts, frame.time_base = RATE, self.pts, fractions.Fraction(1, RATE)
        self.pts += SAMPLES
        return frame


class Sideband:
    """운영 로직이 여는 sideband 연결에 session.started를 보장한다.
    전화(SIP)는 accept 뒤에 세션이 시작돼 sideband가 그 이벤트를 받는다. WebRTC 세션은 sideband가 붙기 전에 이미 시작돼 있어
    이벤트를 놓칠 때가 있고, 그러면 운영 로직이 통화를 active로 넘기지 않아 첫 인사 · 무응답 종료가 없다(11/12 통화 5통).
    그래서 데이터 채널로 받은 같은 이벤트(started)를 맨 앞에 한 번 넣어 주고, 뒤따라 오는 진짜 이벤트는 버린다."""

    def __init__(self, manager, started: bytes):
        self.manager, self.started = manager, started

    async def __aenter__(self):
        conn = await self.manager.__aenter__()
        recv, pending = conn.recv_bytes, [self.started]

        async def recv_bytes() -> bytes:
            if pending:
                return pending.pop()
            while True:
                raw = await recv()
                if b'"type":"session.started"' not in raw[:200]:
                    return raw

        conn.recv_bytes = recv_bytes
        return conn

    async def __aexit__(self, *exc):
        return await self.manager.__aexit__(*exc)


def intercept(real) -> tuple[Proxy, dict]:
    """운영 로직에 줄 OpenAI 클라이언트와, 가로챈 값이 담길 dict.
    sessions.accept: 첫 호출은 운영이 만든 세션 설정(config)을 가로채고 실패시킨다. 그 뒤는 통과(이미 그 설정으로 만든 세션).
    sideband.connect: captured["started"](데이터 채널로 받은 session.started)를 맨 앞에 넣어 주는 연결로 감싼다."""
    captured: dict = {}

    async def accept(call_id, *, session):
        if "config" not in captured:
            captured["config"] = session
            raise RuntimeError("설정만 가로챔")

    def connect(**kwargs):
        return Sideband(real.live.sideband.connect(**kwargs), captured["started"])

    live = Proxy(real.live, sessions=Proxy(real.live.sessions, accept=accept), sideband=Proxy(real.live.sideband, connect=connect))
    return Proxy(real, live=live), captured


async def capture(calls: CallService, captured: dict, caller: str, now: str) -> dict:
    """운영 통화 로직이 이 발신번호 · 지금 페르소나로 만드는 세션 설정(WebRTC 세션을 만들 때 그대로 넣는다)."""
    await calls.on_incoming(IncomingCall(CONFIG_ID, caller, now, None))
    return {k: v for k, v in captured["config"].items() if k != "type"}  # type은 accept 전용


def api_key() -> str:
    """시험 전용 키. 운영 통화와 한도 · 청구를 나누려고 OPENAI_API_KEY를 그대로 쓰지 않는다."""
    key = os.environ.get("PERSONA_CHECK_OPENAI_API_KEY")
    if not key:
        raise RuntimeError("PERSONA_CHECK_OPENAI_API_KEY가 필요합니다")
    return key


def faq_connected() -> bool:
    """FAQ 검색 서버가 설정된 환경인가(운영 서버와 같은 QDRANT_URL · RAG_RERANKER_URL을 쓴다)."""
    return bool(os.environ.get("QDRANT_URL"))


def snapshot_faq(source: Path, target: Path) -> bool:
    """운영 AI의 FAQ 저장 파일(SQLite · WAL)을 읽기만 해서 target으로 복사한다. 시험 묶음마다 한 번.
    원본은 읽기 전용으로 붙어 있고 여기서도 읽기 전용으로 연다. immutable은 WAL에 남은 최근 변경을 못 볼 수 있어 마지막 수단.
    실패하면 False → 그 묶음은 FAQ 검색 없이(KB_UNAVAILABLE) 돈다."""
    if not source.is_file():
        log.warning("운영 FAQ 저장 파일이 없음: %s", source)
        return False
    for flags in ("mode=ro", "mode=ro&immutable=1"):
        try:
            src = sqlite3.connect(f"{source.resolve().as_uri()}?{flags}", uri=True)
            try:
                dst = sqlite3.connect(target)
                try:
                    src.backup(dst)
                finally:
                    dst.close()
            finally:
                src.close()
            return True
        except sqlite3.Error as e:
            log.warning("운영 FAQ 저장 파일 복사 실패(%s): %s", flags, e)
            target.unlink(missing_ok=True)
    return False


def managed_rag(db: Path, cfg):
    """운영 AI와 같은 FAQ 검색(FAQ 관리 화면에 등록된 FAQ의 색인, app.main.build_rag의 관리 색인 경로)을
    운영 FAQ 저장 파일의 복사본(db)으로 붙인다. 운영 Qdrant에는 쓰지 않는다 — 색인 등록 · 삭제와 기동 때 삭제 정리는
    운영 AI만 한다(여기서 불리면 오류). 검색(질문 임베딩 · 벡터 조회 · 리랭커)만 운영과 같다."""
    from langchain_openai import OpenAIEmbeddings
    from qdrant_client import QdrantClient
    from app.rag.faq_events import FaqEventStore
    from app.rag.faq_index import FaqIndex
    from app.rag.faq_index_state import FaqIndexState
    from app.rag.faq_runtime import load_bm25_descriptions
    from app.rag.faq_vectors import QdrantFaqVectors
    from app.rag.remote import RemoteReranker
    from app.rag.service import RagService

    class ReadOnlyVectors(QdrantFaqVectors):
        def stage(self, *_):
            raise RuntimeError("시험 도구는 운영 FAQ 색인에 쓰지 않는다")
        delete_faqs = stage

    class SnapshotIndex(FaqIndex):
        def reconcile_deletions(self):  # 삭제 정리는 운영 AI가 한다
            pass

    f, rag = cfg.faq_sync, cfg.rag
    reranker = RemoteReranker(os.getenv("RAG_RERANKER_URL"), os.getenv("RAG_RERANKER_API_KEY"), rag.http_timeout_sec)
    client = QdrantClient(url=os.environ["QDRANT_URL"], api_key=os.environ["QDRANT_API_KEY"], timeout=rag.http_timeout_sec)
    try:
        events = FaqEventStore(db, max_pending=f.max_pending, busy_timeout_sec=f.busy_timeout_sec)
        state = FaqIndexState(events, collection=f.collection, model=rag.embedding_model, dimensions=rag.dimensions)
        index = SnapshotIndex(state, ReadOnlyVectors(client, collection=f.collection, dimensions=rag.dimensions),
                              OpenAIEmbeddings(model=rag.embedding_model, request_timeout=rag.http_timeout_sec, max_retries=0),
                              validate_chunks=reranker.validate_chunks, embedding_batch_size=f.embedding_batch_size,
                              bm25_weight=rag.bm25_weight, rrf_c=rag.rrf_c, bm25_descriptions=load_bm25_descriptions())
    except BaseException:
        client.close()
        reranker.close()
        raise
    service = RagService(rag, faq_index=index, reranker=reranker)
    service.client = client  # close()가 닫는다(리랭커는 run_call 끝에서)
    return service


def build(client, mock: MockBackend, workdir: Path, faq: Path | None = None):
    """app/main.py lifespan과 같은 조립(관제 · FAQ 동기화 · 미답변 검토 제외). workdir = 결과 아웃박스를 둘 임시 폴더.
    FAQ 검색: 운영이 관리 색인을 쓰고(faq_sync.process_enabled) 묶음의 FAQ 복사본(faq)이 있으면 그 복사본으로 같은 검색을
    (통화마다 workdir에 한 벌 더 복사 — 동시 통화가 한 파일을 잠그지 않게), 아니면 app.main.build_rag의 기본 경로.
    11/12 서버 첫 시험: 기본 경로가 찾는 매뉴얼 컬렉션이 운영에 없어 G1의 FAQ 검색이 전부 KB_UNAVAILABLE이었다."""
    cfg = load_server_config()
    backend = BackendGateway(mock, cfg.backend.max_concurrency, cfg.backend.read_budget_sec, cfg.backend.write_budget_sec)
    policy, fare_of = load_policy(), partial(parcel_fare, table=cfg.fare.model_dump())
    address = AddressService(open_db(Path(os.environ.get("ADDRESS_DB", ROOT / "data" / "address.db"))))
    rag = None
    if faq_connected():
        from app.rag.service import RagService
        if faq is not None and faq.is_file() and cfg.faq_sync.process_enabled:
            try:
                mine = workdir / FAQ_SNAPSHOT
                shutil.copyfile(faq, mine)
                rag = managed_rag(mine, cfg)
            except Exception as e:  # 운영과 같다: FAQ 검색만 끄고 통화는 한다(search_manual이 KB_UNAVAILABLE)
                log.warning("FAQ 관리 색인 준비 실패, FAQ 검색 끔: %s %s", type(e).__name__, str(e)[:200])
        else:
            rag = RagService(cfg.rag)
    calls = CallService(CallDeps(client=client, backend=backend, policy=policy, cfg=cfg.call,
                                 backend_model=os.environ.get("BACKEND_MODEL", "gpt-6-luna"),
                                 backend_effort=os.environ.get("BACKEND_EFFORT", "low"), address=address, rag=rag,
                                 rag_min_score=cfg.rag.min_score, rag_budget_sec=cfg.rag.timeout_sec))
    LiveFlow(calls)
    outbox = Outbox(workdir / "outbox.sqlite3")
    calls.results = ResultService(backend, outbox, policy, fare_of,
                                  cfg.backend.submit_timeout_sec + cfg.backend.submit_retry_sec + 5,
                                  callback_field=cfg.backend.analysis_callback_field)
    if cfg.backend.parcel_draft_intake:
        from app.calls.intake import IntakeService
        calls.intake = IntakeService(backend, outbox, policy, fare_of)
        calls.results.intake = calls.intake
    calls.on_finalize.insert(0, calls.results.finish)
    return calls, address


def all_calls() -> list[dict]:
    """개발용 관제 목록 = 지난 시험 통화(call.json의 스냅샷) + 진행 중 통화."""
    found: dict[str, dict] = {}
    for path in sorted(SAVED.rglob("call.json")):
        try:
            snap = json.loads(path.read_text("utf-8"))["snapshot"]
            found[snap["session_id"]] = snap
        except (OSError, ValueError, KeyError, TypeError):
            continue
    for calls in LIVE:
        for snap in calls.registry.snapshots():
            if snap["session_id"] != CONFIG_ID:
                found[snap["session_id"]] = snap
    return list(found.values())


def save_wav(path: Path, mic: CustomerTrack, ai: list) -> None:
    """통화 녹음: 고객과 AI를 한 소리로 섞은 모노(24kHz). ai = [(받은 시각, 소리)] — 받은 시각 자리에 놓는다.
    좌우로 나눠 저장했더니 한쪽 귀에서만 들려 헷갈렸다(11/11 사용자)."""
    if mic.t0 is None:
        return
    left = np.frombuffer(bytes(mic.sent), dtype=np.int16)
    placed, cursor = [], 0
    for at, pcm in ai:
        start = max(cursor, int((at - mic.t0) * RATE))
        placed.append((start, pcm))
        cursor = start + len(pcm)
    out = np.zeros(max(len(left), cursor), dtype=np.int32)
    out[:len(left)] += left
    for start, pcm in placed:
        out[start:start + len(pcm)] += pcm
    out = np.clip(out, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(RATE)
        f.writeframes(out.tobytes())


def save_report(path: Path, title: str, record: dict, verdict: dict) -> None:
    """통화 한 장 보기(브라우저로 엶): 녹음 재생 + 대화 + 판정 + 백엔드가 받은 것. 같은 폴더의 call.wav를 가리킨다."""
    def block(name, value):
        return f"<h3>{name}</h3><pre>{html.escape(json.dumps(value, ensure_ascii=False, indent=1))}</pre>"

    rows = "".join(f"<tr><td>{at:.1f}s</td><td>{html.escape(who)}</td><td>{html.escape(text)}</td></tr>"
                   for at, who, text in record["customer"]["lines"])
    path.write_text(f"""<!doctype html><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>body{{font:14px/1.6 system-ui;max-width:960px;margin:24px auto;padding:0 16px}}
td{{padding:4px 10px;border-bottom:1px solid #ddd;vertical-align:top}}
td:first-child{{white-space:nowrap;color:#666}}pre{{background:#f5f5f5;padding:10px;white-space:pre-wrap;word-break:break-all}}</style>
<h1>{html.escape(title)}</h1><p>판정: {'통과' if verdict['passed'] else '실패'} ({html.escape(verdict['summary'])})</p>
<p>녹음 <audio controls src="call.wav"></audio></p>
<table>{rows}</table>{block("판정", verdict["checks"])}{block("고객이 고른 행동", record["customer"]["choices"])}
{block("백엔드가 받은 것", {k: record["received"][k] for k in ("drafts", "intakes", "analyses")})}""", encoding="utf-8")


async def voice_of(client, text: str) -> bytes:
    """문장의 고객 음성(PCM16 모노 24kHz). 같은 문장은 저장해 둔 것을 다시 쓴다."""
    path = TTS_DIR / (hashlib.sha1(f"{TTS_MODEL}|{TTS_VOICE}|{text}".encode()).hexdigest()[:16] + ".pcm")
    if not path.exists():
        resp = await asyncio.wait_for(client.audio.speech.create(model=TTS_MODEL, voice=TTS_VOICE, input=text,
                                                                 response_format="pcm"), CALL_TIMEOUT_SEC)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(resp.content)
    return path.read_bytes()


async def run_call(scenario_id: str = "A1", persona: dict | None = None, bus=None, out_dir: Path | None = None) -> dict:
    """시험 통화 한 통을 걸고 판정(judge.judge의 결과 + liveSeconds)을 돌려준다. 통화가 연결되지 않았으면 예외.
    persona = {"promptText": 후보 페르소나 글, "voiceId": 목소리} — 없으면 서버 기본 페르소나. 목소리는 글과 함께 줄 때만 쓰인다."""
    if RTCPeerConnection is None:
        raise RuntimeError("통화를 걸려면 aiortc가 필요합니다(uv pip install --target .pydeps aiortc numpy)")
    persona = persona or {}
    scenario = judge.load_scenario(scenario_id)
    if scenario.get("needs") == "faq" and not faq_connected():
        raise RuntimeError("FAQ 검색 서버(QDRANT_URL)가 연결되지 않아 이 시나리오를 돌릴 수 없음")
    script = [line["text"] for line in scenario["lines"]]
    says = [line.get("say") or customer.spoken(line["text"]) for line in scenario["lines"]]  # 숫자는 한글 읽기로
    caller, who = scenario["caller"], scenario.get("customer")
    facts = (f"등록 고객. 등록된 이름: {who['name']}. 등록된 발송 주소: {who['address']} {who.get('detail', '')}. " if who
             else "처음 이용하는 고객. ") + f"지금 건 전화번호: {caller}"
    out_dir = out_dir or SAVED / f"{datetime.now():%m%d_%H%M%S}"
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- 운영 통화 로직 조립(가짜 백엔드) ---
    real = openai.AsyncOpenAI(api_key=api_key())
    client, captured = intercept(real)
    workdir = Path(tempfile.mkdtemp(prefix="persona_check_"))
    mock = MockBackend()
    seed(mock, scenario)
    if persona.get("promptText"):  # 관리자가 이 글을 적용해 둔 백엔드처럼
        mock.use_prompt(persona["promptText"])
        mock.personas["ACTIVE"]["voiceId"] = persona.get("voiceId")
    calls, address = build(client, mock, workdir, out_dir.parent / FAQ_SNAPSHOT)
    stub_address = address.db is None and not kakao.has_key()
    if stub_address:
        async def geocode(address_, timeout_sec, transport=None, http=None):
            return fake_geo(address_)
        kakao.geocode = geocode
    ended: dict = {}

    async def write_log(s):  # app.main.write_call_log와 같은 내용
        if s.call_id == CONFIG_ID:
            return
        ended["reason"] = str(s.close_reason or "")
        (out_dir / "call.json").write_text(json.dumps(
            {"snapshot": s.snapshot(), "events": s.events, "tool_calls": s.tool_calls, "transcript": s.transcript,
             "backend_calls": s.backend_calls, "timings": s.timings, "stats": dict(s.stats)},
            ensure_ascii=False, indent=1, default=str), encoding="utf-8")

    calls.on_finalize.append(write_log)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    config, _ = await asyncio.gather(capture(calls, captured, caller, now),
                                     asyncio.gather(*(voice_of(real, s) for s in says if s != SILENT)))  # 문장 음성 준비
    if bus is not None:  # 개발용 관제 화면에 이 통화를 실시간으로
        calls.on_change = lambda s: bus.publish({"type": "call", "call": s.snapshot()})
        LIVE.append(calls)

    # --- WebRTC로 세션을 만들고 운영 로직을 붙인다 ---
    state = {"ai_text": "", "ai_voice_at": 0.0, "closed": False, "live_seconds": None}
    started = asyncio.Event()
    mic, ai_audio = CustomerTrack(), []  # ai_audio = [(받은 시각, 24kHz 모노)]
    pc = RTCPeerConnection()
    pc.addTrack(mic)
    channel = pc.createDataChannel("events")

    @channel.on("message")
    def on_message(message):
        ev = json.loads(message) if isinstance(message, str) else {}
        kind = ev.get("type")
        if kind == "session.output_transcript.delta":
            state["ai_text"] += ev.get("delta") or ""
            state["ai_voice_at"] = time.monotonic()
        elif kind == "session.started":
            captured["started"] = message.encode()  # 운영 로직의 sideband에 그대로 넣어 준다(Sideband)
            started.set()
        elif kind == "session.usage.updated":  # 음성 모델 사용량 = 누적 음성 시간(초). 요금의 기준
            state["live_seconds"] = (ev.get("usage") or {}).get("seconds")
        elif kind == "session.closed":
            state["closed"] = True
        elif kind == "error":
            log.warning("Live 오류 %s", json.dumps(ev, ensure_ascii=False)[:300])

    async def hear(track):  # AI 소리가 나는 동안은 고객이 듣는다
        try:
            while True:
                frame = await track.recv()
                mono = frame.to_ndarray().reshape(-1, len(frame.layout.channels)).mean(axis=1)
                # ponytail: 48kHz → 24kHz는 한 칸씩 건너뛰기(듣기용 녹음이라 충분). 음질이 문제면 resample로 바꾼다
                ai_audio.append((time.monotonic(), mono[::max(1, frame.sample_rate // RATE)].astype(np.int16)))
                if np.sqrt(np.mean(mono ** 2)) > VOICE_RMS:
                    state["ai_voice_at"] = time.monotonic()
        except MediaStreamError:  # 통화가 끝나 소리가 끊김
            pass
        except Exception as e:
            log.warning("%s AI 소리 받기 실패 %s", scenario_id, type(e).__name__)
        finally:
            state["closed"] = True

    hearing: list[asyncio.Task] = []  # 참조를 쥐고 있어야 도중에 사라지지 않는다
    pc.on("track", lambda track: hearing.append(asyncio.ensure_future(hear(track))))
    await pc.setLocalDescription(await pc.createOffer())
    made = await real.live.create(session=config, transport={"type": "webrtc", "sdp": pc.localDescription.sdp})
    sid = made.session.id
    lines: list[tuple[str, str]] = []            # (AI|고객, 말) — 고객이 고를 때 보는 대화
    timed: list[tuple[float, str, str]] = []     # (통화 시작부터 초, AI|고객, 말) — 기록
    said: set[int] = set()                       # 말한 대본 번호
    counts: dict[int, int] = {}                  # 번호별 말한 횟수
    choices: list[dict] = []                     # 고객이 고른 행동
    t0 = time.monotonic()

    def note(who: str, text: str, tag: str = "") -> None:
        lines.append((who, text))
        timed.append((round(time.monotonic() - t0, 1), who, text))
        log.info("%s [%5.1fs] %s %s%s", scenario_id, time.monotonic() - t0, who, tag, text)

    def flush_ai() -> str:
        heard, state["ai_text"] = state["ai_text"].strip(), ""
        if heard:
            note("AI", heard)
        return heard

    call = None
    try:  # 세션이 만들어진 뒤에는 어디서 실패하든 아래 finally에서 끊는다 — 세션이 남으면 비용이 샌다
        await pc.setRemoteDescription(RTCSessionDescription(made.transport.sdp, "answer"))
        # 세션이 시작됐다는 알림을 받은 뒤에 운영 로직을 붙인다. 바로 붙이면 sideband가 503으로 거절될 때가 있다(11/11, 통화 1초 만에 끝남)
        await asyncio.wait_for(started.wait(), 15)
        t0 = time.monotonic()
        call = asyncio.create_task(calls.on_incoming(IncomingCall(sid, caller, now, None)))
        log.info("%s %s 통화 시작 %s (페르소나: %s)", scenario_id, scenario["name"], sid,
                 "후보 글" if persona.get("promptText") else "서버 기본")

        # --- 대화: 고객은 대본에서 고른 문장만 말한다 ---
        limit = scenario.get("max_sec", MAX_SEC)
        required = [i for i, line in enumerate(scenario["lines"], 1) if not line.get("optional")]

        def over() -> bool:
            return state["closed"] or call.done() or time.monotonic() - t0 >= limit

        ending = False   # 마무리 인사를 들음: 더 말하지 않고 서버가 끊기를 기다린다
        hellos = 0       # 잇달아 "여보세요?"만 한 횟수
        silent = False   # 무응답 차례를 쓴 뒤로는 AI가 조용해도 부르지 않는다
        moved, last = time.monotonic(), ""   # 고객이 마지막으로 새 말을 한 시각 · 그 말
        waited = time.monotonic()
        while True:
            # 고객 차례 = AI가 새로 말했고 그 소리가 끝난 뒤 잠깐. AI가 너무 오래 조용하면 사람처럼 부른다
            while not over():
                gap = GAP_DONE if state["ai_text"].strip().endswith((".", "?", "!")) else GAP_MID
                idle = not mic.queue and time.monotonic() - state["ai_voice_at"] > gap
                if idle and (state["ai_text"].strip() or time.monotonic() - waited > STUCK_SEC):
                    break
                await asyncio.sleep(0.1)
            if over():
                break
            if not (silent or ending) and time.monotonic() - moved > STALL_SEC:
                log.warning("%s 통화가 %s초째 나아가지 못함 → 통화 중단", scenario_id, STALL_SEC)
                break
            waited = time.monotonic()
            nxt = next((i for i in required if i not in said), None)  # 다음에 말해야 하는 문장
            silent_turn = nxt is not None and script[nxt - 1] == SILENT
            if flush_ai():
                pick = await customer.choose(real, script, lines, said, facts)
            elif ending:        # 마무리 인사 뒤 AI가 조용함 → 고객이 끊는다
                break
            elif silent_turn or silent:   # 무응답 시나리오: AI가 조용해도 계속 가만히
                continue
            elif hellos >= MAX_HELLO:
                log.warning("%s AI가 진행하지 못함(여보세요 %s번) → 통화 중단", scenario_id, MAX_HELLO)
                break
            else:
                hellos += 1
                pick = {"action": "short", "short": "hello", "text": customer.SHORT["hello"], "why": "AI가 오래 조용함"}
            choices.append({"at": round(time.monotonic() - t0, 1), **pick})
            # 고객은 마무리 인사를 들어도 먼저 끊지 않는다(운영은 인사 뒤 서버가 끊는다). AI가 또 물으면 이어서 답한다
            # — 11/11: "네, 요청 감사합니다"를 인사로 보고 끊어 "더 보내실 택배가 있으세요?"에 답하지 못했다
            ending = pick["action"] == "end"
            index = pick.get("index")
            if ending or pick["action"] == "wait" or (index and script[index - 1] == SILENT):
                if silent_turn and not ending:
                    said.add(nxt)  # 이번 차례의 무응답을 썼다
                    silent = True
                continue
            speech = customer.spoken(pick["text"])
            if pick["action"] == "say":
                counts[index] = counts.get(index, 0) + 1
                if counts[index] > MAX_REPEAT:
                    log.warning("%s 대본 %s번을 %s번 말하고도 또 고름 → 통화 중단", scenario_id, index, MAX_REPEAT)
                    break
                said.add(index)
                speech = says[index - 1]
            if pick.get("short") != "hello":
                hellos = 0
                if pick["text"] != last:  # 같은 말을 되풀이하는 것은 나아간 게 아니다
                    moved, last = time.monotonic(), pick["text"]
            note("고객", pick["text"], f"[{pick['action']}{index or ''}] ")
            audio = await voice_of(real, speech)
            mic.queue.extend(audio)
            waited = time.monotonic() + len(audio) / (RATE * 2)
    except Exception as e:  # 고객 쪽(LLM · TTS) · 연결 오류: 통화를 접는다. 취소(CancelledError)는 그대로 올라간다
        log.warning("%s 통화 중단 %s: %s", scenario_id, type(e).__name__, str(e)[:200])
    finally:
        flush_ai()
        try:  # 이미 끝났으면 404
            await asyncio.shield(real.live.sessions.hangup(sid))
        except Exception as e:
            if getattr(e, "status_code", None) != 404:
                log.warning("%s 끊기 실패 %s", scenario_id, type(e).__name__)
    try:
        if call is not None:
            await asyncio.wait_for(call, 90)
    except Exception as e:
        log.warning("%s 통화 정리 대기 실패 %s", scenario_id, type(e).__name__)
    await pc.close()
    await asyncio.to_thread(save_wav, out_dir / "call.wav", mic, ai_audio)  # 큰 파일: 다른 통화의 음성 박자를 막지 않게
    await calls.results.drain()
    await address.close()
    if calls.d.rag is not None:
        await calls.d.rag.close()
        if calls.d.rag.faq_index is not None and calls.d.rag.reranker is not None:
            calls.d.rag.reranker.close()  # 관리 색인 경로에서는 RagService.close가 리랭커를 닫지 않는다
    shutil.rmtree(workdir, ignore_errors=True)
    if calls in LIVE:
        LIVE.remove(calls)

    # --- 기록과 판정 ---
    # 판정기 입력: 이 통화에서 백엔드가 받은 것(계약 모양 그대로) + 고객 쪽 기록. 판정기는 이 파일과 시나리오만 본다
    record = {"scenario": scenario_id, "caller": caller, "liveSeconds": state["live_seconds"], "said": sorted(said),
              "persona": {"candidate": bool(persona.get("promptText")), "voiceId": persona.get("voiceId")},
              "address": "stub" if stub_address else "real",
              "customer": {"lines": timed, "choices": choices},
              "received": {name: getattr(mock, name) for name in
                           ("drafts", "intakes", "events", "analyses", "orders", "results", "unanswered")}}
    record = json.loads(json.dumps(record, ensure_ascii=False, default=str))  # 파일에 쓰는 것과 같은 모양으로(숫자 키 → 글자)
    (out_dir / "backend.json").write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
    verdict = await judge.judge_call(real, scenario, record)
    (out_dir / "verdict.json").write_text(json.dumps(verdict, ensure_ascii=False, indent=1), encoding="utf-8")
    save_report(out_dir / "report.html", f"시험 통화 {scenario_id} {scenario['name']}", record, verdict)
    failed = [f"{c['name']}(기대 {c['expected']!r}, 실제 {c['actual']!r})" for c in verdict["checks"] if c["status"] == "fail"]
    log.info("%s 판정: %s (%s) %s — 기록 %s", scenario_id, "통과" if verdict["passed"] else "실패", verdict["summary"],
             " / ".join(failed), out_dir)
    if not timed and ended.get("reason", "connection").startswith(("connection", "accept")):
        raise RuntimeError(f"통화가 연결되지 않음: {ended.get('reason', '기록 없음')}")  # 시나리오 실패가 아니라 시험 자체의 실패
    return verdict | {"liveSeconds": state["live_seconds"]}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "WARNING"), stream=sys.stdout, format="%(message)s")
    logging.getLogger("persona_check").setLevel(logging.INFO)  # 대화와 판정은 보이게, 운영 코드의 로그는 경고부터
    args = sys.argv[1:]
    candidate = {"promptText": Path(args[1]).read_text("utf-8")} if len(args) > 1 else None
    sys.exit(0 if asyncio.run(run_call(args[0] if args else "A1", candidate))["passed"] else 1)
