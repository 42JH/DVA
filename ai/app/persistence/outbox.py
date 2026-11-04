"""아웃박스(SQLite, call-lifecycle.md §7): 통화 결과·인사이트를 전송 전에 영속하고 재시작에도 같은 키·같은 본문으로 다시 보낸다.

- call_results: 통화당 1행. Idempotency-Key(UUID)와 본문은 처음 만든 뒤 바꾸지 않는다(spec/ai-integration-current.md §3).
  status: PENDING(전송 전·중) · SENT_UNCERTAIN(응답 불확실, 재시작 때 같은 키로 재확인) · DONE(응답 받음) · FAILED(재시도 안 함)
- insights: 통화당 1행. 이벤트(eventId 고정)·분석·미답변 본문과 진행 상태. 같은 eventId 재전송은 BE가 204로 받는다.
신규 의존성 없음(표준 sqlite3). 호출은 짧은 쓰기라 asyncio.to_thread로 이벤트 루프를 막지 않는다.
"""

import json
import sqlite3
import threading
import time
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS call_results(
  session_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL, body_json TEXT NOT NULL,
  status TEXT NOT NULL, last_data_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS insights(
  session_id TEXT PRIMARY KEY, call_session_seq INTEGER NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '{}', updated_at REAL NOT NULL);
"""


class Outbox:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self.lock = threading.Lock()

    def close(self) -> None:
        self.db.close()

    # --- 통화 결과 ---
    def result(self, session_id: str) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT idempotency_key, body_json, status, last_data_json, attempts FROM call_results "
                                  "WHERE session_id=?", (session_id,)).fetchone()
        if not row:
            return None
        return {"session_id": session_id, "key": row[0], "body": json.loads(row[1]), "status": row[2],
                "data": json.loads(row[3]) if row[3] else None, "attempts": row[4]}

    def create_result(self, session_id: str, key: str, body: dict) -> dict:
        """처음이면 저장(전송 전에 커밋), 이미 있으면 기존 행(키·본문 불변)."""
        with self.lock:
            self.db.execute("INSERT OR IGNORE INTO call_results(session_id, idempotency_key, body_json, status, updated_at) "
                            "VALUES(?,?,?,?,?)", (session_id, key, json.dumps(body, ensure_ascii=False), "PENDING",
                                                  time.time()))
        return self.result(session_id)

    def update_result(self, session_id: str, status: str, data: dict | None = None) -> None:
        with self.lock:
            self.db.execute("UPDATE call_results SET status=?, last_data_json=COALESCE(?, last_data_json), "
                            "attempts=attempts+1, updated_at=? WHERE session_id=?",
                            (status, json.dumps(data, ensure_ascii=False) if data is not None else None, time.time(),
                             session_id))

    def unfinished_results(self) -> list[dict]:
        with self.lock:
            ids = [r[0] for r in self.db.execute(
                "SELECT session_id FROM call_results WHERE status IN ('PENDING','SENT_UNCERTAIN')")]
        return [self.result(i) for i in ids]

    # --- 인사이트 ---
    def insight(self, session_id: str) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT call_session_seq, payload_json, status, progress_json FROM insights "
                                  "WHERE session_id=?", (session_id,)).fetchone()
        if not row:
            return None
        return {"session_id": session_id, "call_session_seq": row[0], "payload": json.loads(row[1]),
                "status": row[2], "progress": json.loads(row[3])}

    def create_insight(self, session_id: str, call_session_seq: int, payload: dict) -> dict:
        with self.lock:
            self.db.execute("INSERT OR IGNORE INTO insights(session_id, call_session_seq, payload_json, status, updated_at) "
                            "VALUES(?,?,?,?,?)", (session_id, call_session_seq,
                                                  json.dumps(payload, ensure_ascii=False), "PENDING", time.time()))
        return self.insight(session_id)

    def update_insight(self, session_id: str, status: str, progress: dict) -> None:
        with self.lock:
            self.db.execute("UPDATE insights SET status=?, progress_json=?, updated_at=? WHERE session_id=?",
                            (status, json.dumps(progress, ensure_ascii=False), time.time(), session_id))

    def unfinished_insights(self) -> list[dict]:
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT session_id FROM insights WHERE status='PENDING'")]
        return [self.insight(i) for i in ids]
