"""Record synthetic parity cases while running the unmodified Python reference tests.

Usage: python record-complaint-parity.py REFERENCE_AI_DIR OUTPUT_GZ TIMING_SEED_GZ
Requires the reference project's Python dependencies and pytest.
"""

import base64
import copy
import gzip
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys

import pytest

reference, output, seed = map(Path, sys.argv[1:])
sys.path.insert(0, str(reference.resolve()))
from call_analysis import analyze, extract, facts, timing

cases, records, retained = [], {}, []


def plain(value):
    if isinstance(value, dict):
        return {key: plain(item) for key, item in value.items() if key != "ms"}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    if isinstance(value, set):
        return sorted(value)
    return value


original_events = analyze.from_events


def from_events(events, session_id="", speech=None):
    rec = original_events(events, session_id, speech)
    records[id(rec)] = {"events": copy.deepcopy(events), "speech": copy.deepcopy(speech)}
    retained.append(rec)
    return rec


analyze.from_events = from_events


def record(rec):
    return records[id(rec)] | {"downs": [turn.down for turn in rec.turns]}


def capture(module, name, arguments):
    original = getattr(module, name)

    def wrapped(*args, **kwargs):
        data = copy.deepcopy(arguments(*args, **kwargs))
        result = original(*args, **kwargs)
        cases.append({"fn": name} | plain(data) | {"out": plain(copy.deepcopy(result))})
        return result

    setattr(module, name, wrapped)


capture(analyze, "describe", lambda rec, only=None, mark=None: {"rec": record(rec), "only": only, "mark": mark})
capture(analyze, "check", lambda raw, rec, sources="": {"raw": raw, "rec": record(rec), "sources": sources})
capture(analyze, "vote", lambda analyses, need: {"analyses": analyses, "need": need, "dispute": analyze.DISPUTE})
capture(analyze, "spoken_phone_ok", lambda text: {"text": text})
capture(analyze, "references", lambda faqs=None, rules=True: {"faqs": faqs, "rules": rules})
capture(analyze, "instructions", lambda faqs=None, prompt=analyze.PROMPT, rules=True:
        {"faqs": faqs, "prompt": prompt.name, "rules": rules})
capture(extract, "complaints", lambda analysis, rec: {"analysis": analysis, "rec": record(rec)})
capture(facts, "slow_turns", lambda rec: {"rec": record(rec)})
capture(facts, "info_errors", lambda rec: {"rec": record(rec)})

original_run = analyze.run


async def run(rec, client, effort=analyze.EFFORT, votes=analyze.VOTES, faqs=None):
    replies = [{"error": type(reply).__name__} if isinstance(reply, Exception) else {"text": reply}
               for reply in client.replies]
    data = {"rec": record(rec), "replies": replies, "faqs": copy.deepcopy(faqs), "votes": votes,
            "dispute": analyze.DISPUTE}
    result = await original_run(rec, client, effort, votes, faqs)
    requests = [{"instructions": request["instructions"], "input": request["input"],
                 "name": request["text"]["format"]["name"], "schema": request["text"]["format"]["schema"]}
                for request in client.requests]
    cases.append({"fn": "run"} | plain(data) | {"requests": requests, "out": plain(copy.deepcopy(result))})
    return result


analyze.run = run
code = pytest.main([str(reference / "call_analysis/tests/test_call_analysis.py"), "-q", "-p", "no:cacheprovider"])
assert code == 0, "The unchanged Python reference tests must pass"

# Recompute the existing synthetic audio/timing inputs with the pinned reference.
for case in json.loads(gzip.decompress(seed.read_bytes()))["cases"]:
    case = copy.deepcopy(case)
    name = case["fn"]
    if name == "speech_segments":
        result = timing.speech_segments(base64.b64decode(case["wav"]))
    elif name == "longest_silence":
        result = timing.longest_silence(case["segs"], case["t0"], case["t1"])
    elif name == "text_gap":
        result = timing.text_gap(case["prev"], case["cur"])
    elif name == "pauses":
        result = timing.pauses(case["offsets"], case["segs"], case["said"])
    else:
        continue
    case["out"] = plain(result)
    cases.append(case)

sources = {str(path.relative_to(reference)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
           for path in sorted((reference / "call_analysis").rglob("*"))
           if path.is_file() and path.suffix in (".py", ".md") and "__pycache__" not in path.parts}
data = {"reference": sources, "python": sys.version.split()[0],
        "dependencies": {name: importlib.metadata.version(name) for name in ("numpy", "openai", "pytest")},
        "cases": cases}
encoded = (json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
output.write_bytes(gzip.compress(encoded, mtime=0))
print(json.dumps({"cases": len(cases), "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                  "jsonSha256": hashlib.sha256(encoded).hexdigest()}))
