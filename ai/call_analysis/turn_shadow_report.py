"""Aggregate turn-shadow events from local call logs without printing transcript or field values."""

import argparse
import json
import math
from collections import Counter
from pathlib import Path


def percentiles(values: list[int]) -> dict:
    values = sorted(values)
    return {"n": len(values), "p50": values[math.ceil(len(values) * 0.50) - 1] if values else None,
            "p95": values[math.ceil(len(values) * 0.95) - 1] if values else None}


def summarize(paths) -> dict:
    calls = invalid_logs = 0
    statuses, questions, field_differences, destinations, actions = (Counter() for _ in range(5))
    spoken_ms, ready_ms = [], []
    address_unverified_turns = 0
    for path in paths:
        try:
            log = json.loads(path.read_text(encoding="utf-8"))
            events = log["events"]
            if not isinstance(events, list):
                raise ValueError("invalid events")
        except (OSError, KeyError, ValueError, TypeError):
            invalid_logs += 1
            continue
        rows = [event["data"] for event in events if isinstance(event, dict) and
                event.get("kind") == "Turn shadow" and isinstance(event.get("data"), dict)]
        if skipped := (log.get("stats") or {}).get("Turn shadow 제한", 0):
            statuses["sample_limit"] += skipped
        calls += bool(rows)
        for row in rows:
            status = row.get("status") or "unknown"
            statuses[status] += 1
            if status not in ("ok", "external_action", "decision_timeout", "decision_error"):
                continue
            legacy, shadow = row.get("legacy_spoken_question"), row.get("shadow_question")
            if shadow in ("end", "agent", "confirm_end") or row.get("legacy_state_question") == "end":
                actions[f'{row.get("legacy_state_question")} -> {shadow}'] += 1
            if status != "ok":
                continue
            questions["unobserved" if not legacy else "match" if legacy == shadow else "different"] += 1
            field_differences.update(row.get("differing_fields", ()))
            if "destination_matches" in row:
                destinations["match" if row["destination_matches"] else "different"] += 1
            address_unverified_turns += bool(row.get("address_unverified"))
            if row.get("legacy_spoken_ms") is not None and row.get("shadow_ready_ms") is not None:
                spoken_ms.append(row["legacy_spoken_ms"])
                ready_ms.append(row["shadow_ready_ms"])
    return {"calls": calls, "invalid_logs": invalid_logs, "turn_status": dict(statuses),
            "next_question": dict(questions), "field_differences": dict(field_differences),
            "destination": dict(destinations), "end_or_handoff": dict(actions),
            "address_unverified_turns": address_unverified_turns,
            "legacy_spoken_ms": percentiles(spoken_ms), "shadow_ready_ms": percentiles(ready_ms)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="directory of call JSON logs")
    args = parser.parse_args()
    if not args.directory.is_dir():
        parser.error("directory of call logs does not exist")
    print(json.dumps(summarize(args.directory.glob("*.json")), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
