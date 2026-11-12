"""시험 통화 판정기: 끝난 시험 통화가 시나리오의 정답대로 됐는지 본다.

입력은 두 가지뿐이다.
    scenario  scenarios.toml의 한 시나리오(expect = 코드로 비교할 정답, checks = 행동 확인 항목)
    record    그 통화에서 백엔드가 받은 것(backend.json): 접수 초안 · 접수 완료 요청 · 통화 이벤트 · 통화 분석
              — AI 서버가 백엔드에 보내는 계약 그대로의 모양이라, 통화를 누가 어떻게 돌렸는지와 무관하다

실시간 통화 코드(app/)와 완전히 따로다: import하지 않고, 통화 코드도 이 파일을 부르지 않으며, AI 서버 이미지에 들어가지 않는다.
끝난 통화의 기록만 읽는다. 표준 라이브러리만 쓴다(모델 호출은 넘겨받은 client로).

사실은 코드가, 뜻은 모델이 본다.
    judge()      저장된 값 · 접수 건수 · 지역 · 대본 진행 — 코드 비교(모델 없음)
    behaviour()  시나리오의 checks(무엇을 묻고 무엇을 하지 않는지) — 통화 이벤트를 보여 주고 모델이 판정.
                 모델 답은 미신뢰 입력이라 '어김'은 통화에 글자 그대로 있는 AI 발화를 인용했을 때만 남긴다
행동 검사는 같은 통화를 VOTES판 동시에 판정해 NEED판 이상 같은 답만 남긴다(11/12 실제 통화 4건: 한 판만 보면 16항목 중 3개가 판마다 갈렸다).

    python -m persona_check.judge logs/persona_check/<날짜_시각>      # 저장된 backend.json을 코드 검사로 다시 채점해 찍는다(파일은 안 바꾼다)
"""

import asyncio
import json
import re
import sys
import tomllib
from pathlib import Path

SCENARIOS = Path(__file__).with_name("scenarios.toml")
BOXES = {"document": "documentCount", "small": "smallBoxCount", "medium": "mediumBoxCount", "big": "bigBoxCount"}
BOX_NAMES = {"document": "서류", "small": "소형 박스", "medium": "중형 박스", "big": "대형 박스"}
PASS, FAIL, SKIP = "pass", "fail", "skip"
SILENT = "(무응답)"
AREA = re.compile(r"(\S+?[구군])(?=\s|$)")
STUB_NOTE = "주소 정보를 고정값으로 채운 환경이라 채점하지 않음"
PROMPT = Path(__file__).with_name("judge.md")
MODEL, EFFORT = "gpt-6-luna", "medium"
VOTES, NEED = 3, 2
TIMEOUT_SEC = 90.0
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["items"], "properties": {"items": {"type": "array", "items": {
    "type": "object", "additionalProperties": False, "required": ["no", "verdict", "quote", "why"],
    "properties": {"no": {"type": "integer"}, "verdict": {"type": "string", "enum": ["kept", "broken", "unclear"]},
                   "quote": {"type": "string"}, "why": {"type": "string"}}}}}}


def _digits(value) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _squash(value) -> str:
    return re.sub(r"[\s,.]", "", str(value or ""))


def _check(name: str, expected, actual, same=None, skip: str = "") -> dict:
    if skip:
        return {"name": name, "status": SKIP, "expected": expected, "actual": actual, "note": skip}
    ok = same(expected, actual) if same else expected == actual
    return {"name": name, "status": PASS if ok else FAIL, "expected": expected, "actual": actual}


def area(address) -> str | None:
    """주소의 구 · 군 이름."""
    m = AREA.search(str(address or ""))
    return m.group(1) if m else None


def _boxes(parcel: dict) -> str:
    return ", ".join(f"{BOX_NAMES[k]} {parcel[key]}개" for k, key in BOXES.items() if parcel.get(key)) or "없음"


def _parcel_checks(want: dict, parcel: dict, caller: str, stub: bool) -> list[dict]:
    origin, dest = parcel.get("origin") or {}, parcel.get("destination") or {}
    phone = lambda a, b: _digits(a) == _digits(b)  # noqa: E731
    text = lambda a, b: _squash(a) == _squash(b)   # noqa: E731
    sender_phone = caller if want.get("sender_phone") == "caller" else want.get("sender_phone")
    box, count = want.get("box"), want.get("count", 1)
    wanted_boxes = f"{BOX_NAMES[box]} {count}개" if box else None  # 정답에 물품을 안 적었으면 보지 않는다
    checks = [
        _check("보내는 분 이름", want.get("sender_name"), origin.get("name"), text),
        _check("보내는 분 번호", sender_phone, origin.get("phoneNumber"), phone),
        _check("받는 분 이름", want.get("receiver_name"), dest.get("name"), text),
        _check("받는 분 번호", want.get("receiver_phone"), dest.get("phoneNumber"), phone),
        _check("물품", wanted_boxes, _boxes(parcel)),
        _check("물품 가액", want.get("item_price"), parcel.get("itemPrice")),
    ]
    for label, key, place in (("보내는 곳", "sender", origin), ("받는 곳", "receiver", dest)):
        address, detail = want.get(f"{key}_address"), want.get(f"{key}_detail")
        if stub:
            # 주소DB가 없는 환경: 주소와 상세주소가 갈리지 않고 들은 말 그대로 저장돼 글자 비교는 못 한다.
            # 그래도 엉뚱한 곳(보내는 곳이 받는 곳 주소로 덮임 등)은 잡아야 해서 구 · 군은 비교한다
            checks.append(_check(f"{label} 지역", area(address), area(place.get("roadAddress"))))
            checks.append(_check(f"{label} 상세주소", detail, place.get("detailAddress"), text, STUB_NOTE))
        else:
            checks.append(_check(f"{label} 주소", address, place.get("roadAddress"), text))
            checks.append(_check(f"{label} 상세주소", detail, place.get("detailAddress"), text))
    return [c for c in checks if c["expected"] is not None]  # 정답에 적지 않은 항목은 보지 않는다


def _progress(scenario: dict, record: dict) -> dict:
    """시나리오가 실제로 진행됐는지: 필수 발화(optional 표시가 없는 대본 문장)를 고객이 다 말했는가.
    통화가 중간에 멈추면 '접수가 없어야 함' 같은 정답이 저절로 맞아 버린다(11/12 중도 취소 통화가 72초에 끝남)."""
    lines = scenario.get("lines") or []
    need = [i for i, line in enumerate(lines, 1) if not line.get("optional")]
    if "said" not in record:
        return _check("대본 진행", "필수 발화를 모두 말함", None, skip="통화 진행 기록이 없음")
    missed = [i for i in need if i not in record["said"]]
    return _check("대본 진행", "필수 발화를 모두 말함", f"말하지 못한 발화: {missed}" if missed else "필수 발화를 모두 말함")


def _verdict(scenario: dict, checks: list[dict]) -> dict:
    count = {s: sum(c["status"] == s for c in checks) for s in (PASS, FAIL, SKIP)}
    return {"scenario": scenario["id"], "name": scenario.get("name"), "passed": count[FAIL] == 0, "checks": checks,
            "summary": f"통과 {count[PASS]} · 실패 {count[FAIL]} · 제외 {count[SKIP]}"}


def dialogue(record: dict) -> list[tuple[str, str]]:
    """백엔드가 받은 통화 이벤트 → [(AI|고객|서버, 글)] 시간순. 같은 사람이 이어 말한 발화는 한 줄로 붙인다."""
    events = sorted((e for call in ((record.get("received") or {}).get("events") or {}).values() for e in call.values()),
                    key=lambda e: e.get("eventOrder", 0))
    out: list[tuple[str, str]] = []
    for e in events:
        p = e.get("payload") or {}
        if e.get("kind") == "UTTERANCE":
            who, text = ("AI" if p.get("speaker") == "AI" else "고객"), " ".join(str(p.get("utteranceText") or "").split())
            if out and out[-1][0] == who:
                out[-1] = (who, f"{out[-1][1]} {text}".strip())
            elif text:
                out.append((who, text))
        else:
            out.append(("서버", f"{p.get('action')}: {p.get('summaryText') or ''}".strip()))
    if not out:  # 통화 이벤트가 백엔드에 가지 않은 통화(멈춰서 끊긴 경우): 실행기가 받아 적은 대화로 대신한다
        out = [(who, text) for _, who, text in (record.get("customer") or {}).get("lines") or []]
    return out


def check_behaviour(raw, items: list[str], talk: list[tuple[str, str]]) -> list[dict]:
    """모델 답 → 검사 항목. 어김은 통화의 AI 발화에 글자 그대로 있는 인용이 있어야 남긴다. 없거나 답이 빠진 항목은 제외(판단 못 함)."""
    said = _squash(" ".join(text for who, text in talk if who == "AI"))
    got = {}
    for item in (raw.get("items") if isinstance(raw, dict) else None) or []:
        if isinstance(item, dict) and isinstance(item.get("no"), int):
            got.setdefault(item["no"], item)
    checks = []
    for no, name in enumerate(items, 1):
        item = got.get(no) or {}
        why, quote = " ".join(str(item.get("why") or "").split())[:200], " ".join(str(item.get("quote") or "").split())
        if item.get("verdict") == "kept":
            checks.append({"name": name, "status": PASS, "expected": "지킴", "actual": "지킴", "note": why})
        elif item.get("verdict") == "broken" and len(_squash(quote)) >= 4 and _squash(quote) in said:
            checks.append({"name": name, "status": FAIL, "expected": "지킴", "actual": f"어김: {quote}", "note": why})
        else:
            checks.append({"name": name, "status": SKIP, "expected": "지킴", "actual": "판단 못 함", "note": why or "판정 없음"})
    return checks


async def behaviour(client, scenario: dict, record: dict) -> list[dict]:
    """시나리오의 checks(행동 확인 항목)를 통화 이벤트로 판정한다. 항목이 없으면 [].
    VOTES판 가운데 NEED판 이상 같은 답만 남기고, 갈리거나 모델 호출이 깨진 항목은 제외(통과로도 실패로도 세지 않는다)."""
    items = scenario.get("checks") or []
    if not items:
        return []
    talk = dialogue(record)
    lines = ["[확인 항목]", *(f"{i}. {item}" for i, item in enumerate(items, 1)), "", "[통화]",
             *(f"{i}. {'[서버]' if who == '서버' else who + ':'} {line}" for i, (who, line) in enumerate(talk, 1))]
    text = "\n".join(lines)

    async def one() -> list[dict]:
        try:
            resp = await asyncio.wait_for(client.responses.create(
                model=MODEL, instructions=PROMPT.read_text("utf-8"), input=text, reasoning={"effort": EFFORT},
                text={"format": {"type": "json_schema", "name": "behaviour", "strict": True, "schema": SCHEMA}}), TIMEOUT_SEC)
            raw = json.loads(resp.output_text)
        except Exception as e:
            raw = {"items": [{"no": i, "verdict": "unclear", "quote": "", "why": f"판정 모델 호출 실패({type(e).__name__})"}
                             for i in range(1, len(items) + 1)]}
        return check_behaviour(raw, items, talk)

    return vote(await asyncio.gather(*(one() for _ in range(VOTES))))


def vote(rounds: list[list[dict]], need: int = NEED) -> list[dict]:
    """판마다 나온 검사 결과에서 need판 이상 같은 답만. 갈린 항목은 제외로 남긴다."""
    out = []
    for answers in zip(*rounds, strict=True):
        for status in (FAIL, PASS, SKIP):
            same = [a for a in answers if a["status"] == status]
            if len(same) >= need:
                out.append(same[0])
                break
        else:
            out.append({**answers[0], "status": SKIP, "actual": "판단 못 함", "note": "판마다 판정이 갈림"})
    return out


async def judge_call(client, scenario: dict, record: dict) -> dict:
    """통화 한 건의 전체 판정: 코드 검사 + 행동 검사."""
    return _verdict(scenario, judge(scenario, record)["checks"] + await behaviour(client, scenario, record))


def judge(scenario: dict, record: dict) -> dict:
    """시나리오 한 건의 판정(코드 검사): {"scenario", "passed", "checks": [{name, status, expected, actual}]}.
    실패가 하나도 없으면 통과. skip(이 환경에서 볼 수 없는 항목)은 통과 · 실패 어느 쪽에도 넣지 않는다."""
    want, got = scenario.get("expect") or {}, record.get("received") or {}
    drafts = sorted((got.get("drafts") or {}).values(), key=lambda d: d.get("draftSeq", 0))
    ready = [d for d in drafts if d.get("status") == "READY"]
    registered = sum(a.get("registeredParcelCount") or 0 for a in (got.get("analyses") or {}).values())
    stub = record.get("address") == "stub"
    checks = [_progress(scenario, record)]
    if want.get("outcome") == "registered":
        parcels = want.get("parcels", 1)
        checks.append(_check("접수된 택배 수", parcels, registered))
        checks.append(_check("접수 확인된 초안 수", parcels, len(ready)))
        # 보내는 분은 정답에 따로 적지 않으면 발신번호 · 등록 고객의 이름과 발송 주소여야 한다
        # — 11/12: 발송 주소를 정답에 안 적은 시나리오가, 받는 곳 주소로 덮인 통화를 통과시켰다
        who = scenario.get("customer") or {}
        parcel = {"sender_phone": "caller", "sender_name": who.get("name"), "sender_address": who.get("address"),
                  "sender_detail": who.get("detail")} | (want.get("parcel") or {})
        target = (ready or drafts or [{}])[-1]  # 접수가 안 됐어도 마지막 초안으로 어떤 값까지 들어갔는지 보여 준다
        checks += _parcel_checks(parcel, target.get("parcel") or {}, record.get("caller", ""), stub)
    elif want.get("outcome") in ("none", "lookup", "cancelled"):  # 새 접수가 생기면 안 되는 통화
        checks.append(_check("접수된 택배 수", 0, registered))
        checks.append(_check("접수 확인된 초안 수", 0, len(ready)))
        if want["outcome"] == "lookup":
            found = sum(a.get("orderLookupCount") or 0 for a in (got.get("analyses") or {}).values())
            checks.append(_check("조회 실행", "1회 이상", f"{found}회", lambda _, __: found >= 1))
    else:
        raise ValueError(f"모르는 정답 종류: {want.get('outcome')!r}")
    if want.get("faq_answers"):  # 검색 근거로 답한 횟수(통화 분석의 faqAnswerCount)
        need = want["faq_answers"]
        answered = sum(a.get("faqAnswerCount") or 0 for a in (got.get("analyses") or {}).values())
        checks.append(_check("FAQ 답변", f"{need}회 이상", f"{answered}회", lambda _, __: answered >= need))
    if scenario.get("orders"):  # 심어 둔 기존 주문: 취소하기로 한 건만 취소되고 나머지는 그대로여야 한다
        cancel = want.get("receiver") if want.get("outcome") == "cancelled" else None
        expected = {o["receiver"]: "CANCELLED" if o["receiver"] == cancel else o["status"] for o in scenario["orders"]}
        actual = {p["destination"]["name"]: o.get("status") for o in got.get("orders") or [] for p in o.get("parcels") or []}
        checks.append(_check("기존 주문 상태", expected, {name: actual.get(name) for name in expected}))
    return _verdict(scenario, checks)


def load_scenarios() -> list[dict]:
    """시나리오 목록. 공통 테스트 데이터([data])를 풀어 넣는다: caller, customer(등록 고객이면 이름 · 주소), pins, orders."""
    doc = tomllib.loads(SCENARIOS.read_text("utf-8"))
    data = doc.get("data") or {}
    out = []
    for s in doc["scenario"]:
        if s.get("customer"):
            who = data["customer"]
            s = s | {"caller": who["caller"], "customer": {k: who[k] for k in ("name", "address", "detail") if k in who},
                     "pins": data.get("pins") or [], "orders": data.get("orders") or []}
        else:
            s = s | {"caller": data["new_caller"], "customer": None}
        out.append(s)
    return out


def load_scenario(scenario_id: str) -> dict:
    return {s["id"]: s for s in load_scenarios()}[scenario_id]


def main(folder: str) -> int:
    record = json.loads((Path(folder) / "backend.json").read_text("utf-8"))
    verdict = judge(load_scenario(record["scenario"]), record)
    print(f"{verdict['scenario']} {verdict['name']}: {'통과' if verdict['passed'] else '실패'} ({verdict['summary']})")
    for c in verdict["checks"]:
        mark = {"pass": "OK  ", "fail": "FAIL", "skip": "-   "}[c["status"]]
        print(f"  {mark} {c['name']}: 기대 {c['expected']!r} / 실제 {c['actual']!r}")
    return 0 if verdict["passed"] else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main(sys.argv[1]))
