"""실서버 시험: 실제 끝난 통화로 판정 서비스(server.py)를 끝까지 돌려 본다 — 백엔드가 할 일을 흉내 냄
(기록 · 녹음 · FAQ 읽기 → 녹음 말소리 구간 계산 → POST /analyze).

서버는 아무것도 바꾸지 않는다. 실서버는 관리자 화면이 쓰는 읽기 API로만 읽고, 판정은 이 PC에 띄운 서비스로 보낸다.
대본은 개인정보라 화면에 글을 찍지 않는다(통화 번호 · 유형 · 발화 번호 · 되묻기 수 · 토큰 · 시간만). 파일로도 남기지 않는다.

    # 1) 서비스 (ai/ 폴더)
    CALL_ANALYSIS_TOKEN=아무글자 CALL_ANALYSIS_OPENAI_API_KEY=전용키 uvicorn call_analysis.server:app --port 8090
    # 2) 시험 (다른 창, ai/ 폴더)
    DVA_API=https://<실서버>/api DVA_LOGIN_ID=... DVA_PASSWORD=... CALL_ANALYSIS_TOKEN=같은글자 \\
        python -m call_analysis.try_live 10          # 최근 끝난 통화 10건
        python -m call_analysis.try_live 9101 9105   # 그 통화들만 (100보다 큰 숫자 = 통화 번호)

같은 입력으로 다시 판정할 때(정답 채점 · 실서버 502 회피): TRY_LIVE_CACHE=폴더(<통화>.json 이벤트), TRY_LIVE_AUDIO=폴더(<통화>.wav).
둘 다 개인정보라 저장소 밖 임시 폴더에만 둔다. 출력 줄은 evaluate.py가 그대로 읽는다.
"""

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

import httpx

from call_analysis import timing

API = os.environ.get("DVA_API", "http://localhost:5173/api").rstrip("/")  # 기본 = 프론트 개발 서버(5173)의 실서버 프록시
SERVICE = os.environ.get("ANALYZE_URL", "http://127.0.0.1:8090").rstrip("/")
# 백엔드는 로그인 같은 변경 요청에 허용된 Origin을 요구(auth.guard, 없으면 403) — 브라우저처럼 화면 주소를 붙임. 기본 = DVA_API의 주소
ORIGIN = os.environ.get("DVA_ORIGIN") or "{0.scheme}://{0.netloc}".format(urlsplit(API))


def fetch_all(api: httpx.Client, path: str) -> list[dict]:
    out, offset = [], 0
    while True:
        r = api.get(path, params={"limit": 100, "offset": offset})
        if r.status_code >= 500:  # 실서버 게이트웨이가 가끔 502 — 한 번 더
            time.sleep(2)
            r = api.get(path, params={"limit": 100, "offset": offset})
        r.raise_for_status()
        body = r.json()
        out += body["data"]
        if not body.get("hasNext") or not body["data"]:
            return out
        offset += len(body["data"])


def events_of(api: httpx.Client, seq: int) -> list[dict]:
    """관리자 읽기 API(대본 · AI 동작 · 처리 결과) → EVT-01 이벤트 — 백엔드가 DB에서 바로 만들 모양 (CONTRACT.md).
    대본 API의 receivedAt은 말한 시각이 아니라 백엔드가 기록을 한꺼번에 받은 시각(통화 끝, 모든 발화가 같은 값)이라 쓰지 않는다
    → 발화 시각 = 통화 기준 시각 + offsetSeconds. 기준 시각은 AI 동작의 occurredAt − offsetSeconds (11/05 실서버에서 발견)"""
    from datetime import datetime, timedelta

    actions = [("AI_ACTION", a) for a in fetch_all(api, f"/calls/{seq}/actions")]
    actions += [("BUSINESS_RESULT", a) for a in fetch_all(api, f"/calls/{seq}/processing-results")]
    bases = sorted(datetime.fromisoformat(a["occurredAt"].replace("Z", "+00:00")) - timedelta(seconds=a["offsetSeconds"])
                   for _, a in actions if a.get("offsetSeconds") is not None)
    base = bases[len(bases) // 2] if bases else None
    events = []
    for u in fetch_all(api, f"/calls/{seq}/transcript"):
        at = (base + timedelta(seconds=u["offsetSeconds"])).isoformat() if base and u["offsetSeconds"] is not None             else u["receivedAt"]
        events.append({"kind": "UTTERANCE", "occurredAt": at, "offsetSeconds": u["offsetSeconds"],
                       "payload": {"utteranceOrder": u["utteranceOrder"], "speaker": u["speaker"],
                                   "utteranceText": u["utteranceText"]}})
    events += [{"kind": kind, "occurredAt": a["occurredAt"], "offsetSeconds": a["offsetSeconds"],
                "payload": {"action": a["action"], "summaryText": a["summaryText"]}
                | {k: a[k] for k in ("answerUtteranceOrder", "questionUtteranceOrder", "faqEntrySeqs") if a.get(k) is not None}}
               for kind, a in actions]
    return events


def speech_of(api: httpx.Client, seq: int) -> list | None:
    """녹음 → 말소리 구간(백엔드가 할 일 흉내). TRY_LIVE_AUDIO=폴더에 <통화>.wav가 있으면 그걸로, 없으면 통화 상세의 녹음 URL에서.
    녹음이 없으면 None(시간 근거 없이 판정). 녹음은 개인정보 — 임시 폴더만."""
    local = Path(os.environ.get("TRY_LIVE_AUDIO", "")) / f"{seq}.wav"
    if os.environ.get("TRY_LIVE_AUDIO") and local.exists():
        return timing.speech_segments(local.read_bytes())
    detail = api.get(f"/calls/{seq}")
    if detail.status_code != 200:
        return None
    body = detail.json()
    rec = next((r for r in (body.get("data", body).get("recordings") or []) if r.get("url")), None)
    if not rec:
        return None
    wav = httpx.get(rec["url"], timeout=120)
    return timing.speech_segments(wav.content) if wav.status_code == 200 else None


def main(args: list[str]) -> None:
    nums = [int(a) for a in args] or [10]
    seqs = [n for n in nums if n > 100]
    api = httpx.Client(base_url=API, timeout=30, headers={"Origin": ORIGIN})
    try:
        r = api.post("/auth/login", json={"loginId": os.environ["DVA_LOGIN_ID"], "password": os.environ["DVA_PASSWORD"]})
    except httpx.ConnectError:
        sys.exit(f"실서버에 연결 못 함: {API} — 5173 개발 서버(실서버 연결)를 켜거나 DVA_API에 실서버 주소(https://…/api)를 넣으세요")
    if r.status_code != 200:
        hint = f"Origin {ORIGIN}이 허용 목록에 없음 — DVA_ORIGIN에 관리자 화면 주소를 넣으세요" if r.status_code == 403 else "DVA_LOGIN_ID · DVA_PASSWORD 확인"
        sys.exit(f"로그인 실패 {r.status_code} — {hint}")
    # 세션 쿠키(dva_session)를 직접 실어 보냄 — Secure 쿠키는 http://localhost:5173 프록시로는 저절로 안 실림
    api.headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in r.cookies.items())
    if not seqs:
        calls = api.get("/calls", params={"limit": 100, "offset": 0}).json()["data"]
        seqs = [c["callSessionSeq"] for c in calls if c.get("endedAt")][: nums[0]]
    svc = httpx.Client(base_url=SERVICE, timeout=180,
                       headers={"Authorization": f"Bearer {os.environ['CALL_ANALYSIS_TOKEN']}"})
    t0 = time.monotonic()
    # FAQ 원문(백엔드 FAQ 목록) — 근거 없는 답변 대조용. 백엔드가 할 일 흉내
    faqs = [{"question": f.get("question"), "answer": f.get("answer")} for f in fetch_all(api, "/faqs")]

    def one(seq: int) -> dict | None:
        try:
            # TRY_LIVE_CACHE=폴더: 미리 받아 둔 <통화>.json이 있으면 그걸로(실서버 502 · 같은 입력으로 다시 판정할 때). 개인정보 — 임시 폴더만
            cached = Path(os.environ.get("TRY_LIVE_CACHE", "")) / f"{seq}.json"
            events = json.loads(cached.read_text(encoding="utf-8")) if os.environ.get("TRY_LIVE_CACHE") and cached.exists() \
                else events_of(api, seq)
        except httpx.HTTPStatusError as e:
            print(f"통화 {seq}  기록 읽기 실패 {e.response.status_code} — 건너뜀", flush=True)
            return None
        said = sum(e["kind"] == "UTTERANCE" for e in events)
        speech = speech_of(api, seq)
        t = time.monotonic()
        try:
            res = svc.post("/analyze", json={"callSessionSeq": seq, "events": events, "speech": speech, "faqs": faqs})
        except httpx.ConnectError:
            print(f"판정 서비스에 연결 못 함: {SERVICE} — 창 1에서 uvicorn을 먼저 띄우세요", flush=True)
            return None
        sec = time.monotonic() - t
        if res.status_code != 200:
            print(f"통화 {seq}  발화 {said}  → {res.status_code} {res.json().get('detail')}  {sec:.1f}초", flush=True)
            return None
        body = res.json()
        found = [f"{c['type']}@{c['utteranceOrders']}" for c in body["complaints"]] or ["불만 없음"]
        print(f"통화 {seq}  발화 {said}  {' · '.join(found)}  되묻기 {body['repeatQuestionCount']}  "
              f"{body['votes']}판  {sec:.1f}초", flush=True)
        return body

    # 서비스 동시 처리 수(CALL_ANALYSIS_CONCURRENCY, 기본 2)만큼 함께 보낸다 — 끝나는 순서대로 찍힘
    with ThreadPoolExecutor(int(os.environ.get("CALL_ANALYSIS_CONCURRENCY", "2"))) as pool:
        bodies = [b for b in pool.map(one, seqs) if b]
    total = {k: sum((b.get("tokens") or {}).get(k) or 0 for b in bodies) for k in ("input", "cached", "output", "reasoning")}
    print(f"\n판정 {len(bodies)}/{len(seqs)}건 · 전체 {time.monotonic() - t0:.0f}초 · 토큰 합 {json.dumps(total)}")
    print("비용은 OpenAI 사용량 화면(전용 키 프로젝트)에서 확인 — 반영이 몇 분 늦을 수 있음")


if __name__ == "__main__":
    main(sys.argv[1:])
