"""FAQ 변경 알림의 엄격한 입력 계약과 SQLite 영속 FIFO.

이 모듈은 임베딩·Qdrant·백엔드 API를 호출하지 않는다. 접수와 검색 반영을 분리한다.
"""

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator, model_validator


FaqId = Annotated[int, Field(strict=True, ge=1, le=2147483647)]
_DELETE_IDS = TypeAdapter(Annotated[list[FaqId], Field(min_length=1, max_length=100)])


def deletion_keys(ids):
    values = _DELETE_IDS.validate_python(list(ids))
    if len(set(values)) != len(values):
        raise ValueError('삭제할 FAQ 번호가 중복됩니다.')
    return tuple(f'backend-faq:{value}' for value in sorted(values))


class FaqDeletionChanged(RuntimeError):
    """준비 중 삭제 알림이 도착해 후보 판본을 다시 만들어야 한다."""


class FaqChange(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)

    event_id: str = Field(alias='eventId')
    operation: Literal['INSERT', 'UPDATE', 'DELETE']
    faq_ids: list[FaqId] = Field(alias='faqEntrySeqs', min_length=1, max_length=100)

    @field_validator('event_id')
    @classmethod
    def uuid_value(cls, value):
        return str(UUID(value))

    @model_validator(mode='after')
    def valid_ids(self):
        if len(set(self.faq_ids)) != len(self.faq_ids):
            raise ValueError('FAQ 번호가 중복됩니다.')
        if self.operation == 'UPDATE' and len(self.faq_ids) != 1:
            raise ValueError('수정 알림은 번호 하나만 받습니다.')
        return self

    def canonical(self):
        # 번호 배열의 순서만 다른 재전송은 같은 변경이다.
        return json.dumps({'eventId': self.event_id, 'operation': self.operation,
                           'faqEntrySeqs': sorted(self.faq_ids)}, sort_keys=True, separators=(',', ':'))


class EventConflict(ValueError):
    """같은 알림 번호를 다른 변경에 재사용했다."""


class QueueFull(RuntimeError):
    """접수 가능한 미완료 작업 수를 넘었다. 백엔드 재전송이 필요하다."""


class FaqEventStore:
    """매 작업에서 연결을 열고 닫는다. 연결이나 트랜잭션을 await 너머로 공유하지 않는다."""

    def __init__(self, path: Path, *, max_pending: int, busy_timeout_sec: float):
        self.path = Path(path)
        if str(self.path) == ':memory:':
            raise ValueError('FAQ 알림은 영속 파일에 저장해야 합니다.')
        self.max_pending, self.busy_timeout_sec = max_pending, busy_timeout_sec
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path.touch(mode=0o600, exist_ok=True)
        self.path.chmod(0o600)
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS faq_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'QUEUED'
                    CHECK(status IN ('QUEUED','PROCESSING','RETRY','APPLIED')),
                received_at REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                retry_at REAL NOT NULL DEFAULT 0,
                last_error TEXT,
                applied_at REAL
            )''')
            db.execute('''CREATE TABLE IF NOT EXISTS faq_delete_blocks (
                faq_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('PENDING','CLEANED')))''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=self.busy_timeout_sec, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('PRAGMA synchronous=FULL')
            yield db
        except BaseException:
            if db.in_transaction:
                db.rollback()
            raise
        finally:
            db.close()

    def enqueue(self, event: FaqChange):
        payload = event.canonical()
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            previous = db.execute('SELECT payload FROM faq_events WHERE event_id=?', (event.event_id,)).fetchone()
            if previous is not None:
                if previous['payload'] != payload:
                    raise EventConflict('알림 번호에 연결된 변경이 다릅니다.')
                db.commit()
                return False
            pending = db.execute("SELECT count(*) FROM faq_events WHERE status!='APPLIED'").fetchone()[0]
            if pending >= self.max_pending:
                raise QueueFull('미완료 FAQ 작업이 가득 찼습니다.')
            db.execute('INSERT INTO faq_events(event_id,payload,received_at) VALUES(?,?,?)',
                       (event.event_id, payload, time.time()))
            if event.operation == 'DELETE':
                self._block(db, deletion_keys(event.faq_ids), event.event_id)
            db.commit()  # 커밋에 성공한 뒤에만 수신 API가202를 돌려준다.
            return True

    @staticmethod
    def _block(db, keys, event_id):
        db.executemany('''INSERT INTO faq_delete_blocks VALUES(?,?,'PENDING')
            ON CONFLICT(faq_id) DO UPDATE SET status='PENDING' ''', [(key, event_id) for key in keys])

    def block_deletes(self, ids, event_id):
        keys = deletion_keys(ids)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            self._block(db, keys, event_id)
            db.commit()

    def blocked_ids(self):
        # CLEANED도 계속 차단한다. 백엔드 FAQ 번호를 삭제 후 재사용하지 않는 계약이다.
        with self.connect() as db:
            return frozenset(row[0] for row in db.execute('SELECT faq_id FROM faq_delete_blocks'))

    def deletion_status(self):
        with self.connect() as db:
            return dict(db.execute('SELECT faq_id,status FROM faq_delete_blocks').fetchall())

    def get(self, event_id: str):
        with self.connect() as db:
            row = db.execute('SELECT * FROM faq_events WHERE event_id=?', (event_id,)).fetchone()
            return dict(row) if row is not None else None

    def claim_next(self, *, now: float | None = None):
        """선행 실패/실행 중 작업을 추월하지 않는다. 단일 소비자가 사용한다."""
        now = time.time() if now is None else now
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT * FROM faq_events WHERE status!='APPLIED' ORDER BY seq LIMIT 1").fetchone()
            if row is None or row['status'] == 'PROCESSING' or row['retry_at'] > now:
                db.commit()
                return None
            db.execute("UPDATE faq_events SET status='PROCESSING',attempts=attempts+1 WHERE seq=?", (row['seq'],))
            db.commit()
            return FaqChange.model_validate_json(row['payload'])

    def applied(self, event_id: str):
        with self.connect() as db:
            changed = db.execute("""UPDATE faq_events SET status='APPLIED',last_error=NULL,
                retry_at=0,applied_at=? WHERE event_id=? AND status='PROCESSING'""",
                (time.time(), event_id)).rowcount
            if changed != 1:
                raise RuntimeError('실행 중이 아닌 작업을 완료할 수 없습니다.')

    def retry(self, event_id: str, *, error_code: str, retry_at: float):
        # 상세 예외/본문/비밀값 대신 미리 정한 오류 코드만 보관한다.
        if error_code not in {'APPLY_FAILED', 'INTERRUPTED', 'FETCH_FAILED', 'PREPARE_FAILED', 'INDEX_FAILED', 'ACK_FAILED'}:
            raise ValueError('허용하지 않은 오류 코드입니다.')
        with self.connect() as db:
            changed = db.execute("""UPDATE faq_events SET status='RETRY',last_error=?,retry_at=?
                WHERE event_id=? AND status='PROCESSING'""", (error_code, retry_at, event_id)).rowcount
            if changed != 1:
                raise RuntimeError('실행 중이 아닌 작업은 재시도 처리할 수 없습니다.')

    def recover_interrupted(self):
        """다른 소비자가 없는 기동 시에만 호출한다. 처리 도중 죽은 작업을 재시도한다."""
        with self.connect() as db:
            return db.execute("""UPDATE faq_events SET status='RETRY',last_error='INTERRUPTED',
                retry_at=0 WHERE status='PROCESSING'""").rowcount
