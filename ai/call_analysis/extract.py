"""통화 분석 결과에서 값 뽑기(코드, 토큰 없음). 백엔드 분석(ANL-01)의 hasComplaint·complaints·repeatQuestionCount 모양.

접수·조회·취소 건수, 신규 고객, 상담원 요청, FAQ 답변 수는 새 AI 서버가 실제 처리 기록으로 세어 보내므로 다시 세지 않는다.
새로 뽑을 값이 생기면 분석을 다시 하지 않고 여기에 함수만 더한다.
"""

from call_analysis import facts
from call_analysis.analyze import Record

MAX_COMPLAINTS = 20  # 백엔드 ANL-01 상한
MERGE_GAP = 1  # 같은 문제가 이만큼 차례 안에 다시 나오면 한 건 (11/05 실서버: 번호 되묻기 한 장면이 쪼개져 부풀려짐. 2면 서로 다른 일까지 합쳐져 1로)
DEFAULT_REASON = {"RECOGNITION_FAILURE": "고객이 준 정보를 잘못 받음", "INTENT_FAILURE": "고객의 질문·요청을 다르게 받음",
                  "UNGROUNDED_ANSWER": "FAQ · 업무 규칙과 다르게 안내함",
                  "SLOW_RESPONSE": "AI 응답이 늦어 고객이 기다림", "INTERRUPTION": "고객이 끼어들어 AI 말이 중간에 끊김", "CUSTOMER_CONFUSION": "고객이 AI 말을 못 알아들음",
                  "FRUSTRATION": "고객이 불만을 드러냄"}


def complaints(analysis: dict, rec: Record) -> list[dict]:
    """문제가 있는 차례를 불만으로. 유형마다 같은 문제가 이어지거나 MERGE_GAP 차례 안에 다시 나오면 한 건으로 합친다(사이 차례 발화도 넣음).
    말 끊김(INTERRUPTION)은 모델 판정이 아니라 대본에서 AI 말이 잘린 차례를 그대로 센다.
    고객 불만(FRUSTRATION)은 AI 잘못과 따로 센다(11/10 사용자): 고객이 불만을 말한 차례(complain 다수결). 근거는 그 고객 말,
    대상(target) · 강도(level)를 붙인다 — 이어진 불만을 합치면 강도는 센 쪽(explicit), 대상은 첫 불만 것.
    백엔드 CallComplaintDto 모양."""
    by_no = {t.no: t for t in rec.turns}
    marks: dict[str, list[dict]] = {}
    for t in analysis["turns"]:
        if t["issue"]:
            marks.setdefault(t["issue"], []).append(t)
        if t.get("complain"):
            marks.setdefault("FRUSTRATION", []).append(t)
    # 코드로 확정하는 것(facts.py): 말 끊김 · 응답 지연 · 정보 인식 사실 — 판정 없이 대본 · 녹음 그대로
    turn_of = {u.order: t.no for t in rec.turns for u in t.utterances}
    for t in rec.turns:
        if any(u.cut for u in t.utterances):
            marks.setdefault("INTERRUPTION", []).append({"t": t.no, "issue": "INTERRUPTION", "why": ""})
    for a, b in facts.slow_turns(rec):
        marks.setdefault("SLOW_RESPONSE", []).append({"t": turn_of[b], "issue": "SLOW_RESPONSE", "why": ""})
    for a, b, why in facts.info_errors(rec):
        marks.setdefault("RECOGNITION_FAILURE", []).append({"t": turn_of[a], "issue": "RECOGNITION_FAILURE", "why": why})
    for kind in marks:  # 모델 판정과 코드 사실이 섞여도 차례 순서로 합친다(같은 차례는 한 번)
        seen: dict[int, dict] = {}
        for t in marks[kind]:
            seen.setdefault(t["t"], t)
        marks[kind] = [seen[n] for n in sorted(seen)]
    out: list[tuple[int, dict]] = []
    for kind, ts in marks.items():
        last = None
        for t in ts:
            orders = [u.order for u in by_no[t["t"]].utterances]
            if last is not None and t["t"] - last <= MERGE_GAP + 1:
                between = [u.order for n in range(last + 1, t["t"]) if n in by_no for u in by_no[n].utterances]
                out[-1][1]["utteranceOrders"] += between + orders
                if kind == "FRUSTRATION" and t.get("complain_level") == "explicit":
                    out[-1][1]["level"] = "explicit"
            else:
                why = t.get("complain_quote") if kind == "FRUSTRATION" else t["why"] if t["issue"] == kind else ""
                c = {"type": kind, "evidenceText": why or DEFAULT_REASON[kind],
                     "offsetSeconds": by_no[t["t"]].utterances[0].offset, "utteranceOrders": orders}
                if kind == "FRUSTRATION":
                    c |= {"target": t.get("complain_target"), "level": t.get("complain_level")}
                out.append((t["t"], c))
            last = t["t"]
    return [c for _, c in sorted(out, key=lambda x: x[0])][:MAX_COMPLAINTS]


def repeat_questions(analysis: dict, rec: Record) -> int:
    """되묻기: AI가 물은 항목(asked)이 그 차례까지 고객이 이미 준 항목(given)인 횟수. 복창·확인은 asked가 아니다.
    택배 조회가 있던 차례에 고객이 말한 값은 조회용이라 접수 값으로 치지 않는다."""
    lookups = {t.no for t in rec.turns if any(a == "PREVIOUS_ORDER_SEARCH" for _, a, _ in t.actions)}
    given, n = set(), 0
    for t in analysis["turns"]:
        if t["t"] not in lookups:
            given |= set(t["given"])
        n += len(given & set(t["asked"]))
    return n


def values(analysis: dict | None, rec: Record) -> dict:
    """분석 하나 → ANL-01 값. 분석이 없으면(미분석) hasComplaint·repeatQuestionCount는 null, complaints는 빈 목록."""
    if analysis is None:
        return {"hasComplaint": None, "complaints": [], "repeatQuestionCount": None}
    found = complaints(analysis, rec)
    return {"hasComplaint": bool(found), "complaints": found, "repeatQuestionCount": repeat_questions(analysis, rec)}
