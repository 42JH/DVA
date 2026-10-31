"""FAQ 원문/청크 판본과 임베딩 캐시. 네트워크 호출 없이 SQLite에 영속화한다."""

import hashlib
import json
import math
from dataclasses import asdict

from app.rag.faq_documents import FORMAT, FaqChunk, FaqDocuments
from app.rag.faq_events import FaqDeletionChanged, FaqEventStore, deletion_keys
from app.rag.faq_source import FaqEntry


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _checksum(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def checked_vector(value, dimensions):
    if not isinstance(value, (list, tuple)) or len(value) != dimensions:
        raise ValueError('임베딩 벡터 차원이 다릅니다.')
    if any(type(number) not in (float, int) for number in value):
        raise ValueError('임베딩 벡터는 숫자 배열이어야 합니다.')
    try:
        vector = tuple(float(number) for number in value)
        norm = math.hypot(*vector)
    except (OverflowError, ValueError):
        raise ValueError('임베딩 벡터 값이 올바르지 않습니다.') from None
    if not all(math.isfinite(number) and abs(number) <= 3.4028234663852886e38 for number in vector) or not 0 < norm < math.inf:
        raise ValueError('유한한 float32 비영벡터가 필요합니다.')
    return vector


def _encode_faq(item):
    return _json({'source': item.source.model_dump(by_alias=True), 'faq_id': item.faq_id,
                  'version': item.version, 'source_sha256': item.source_sha256,
                  'chunks': [asdict(chunk) for chunk in item.chunks]})


def _decode_faq(payload, checksum):
    if _checksum(payload) != checksum:
        raise ValueError('저장된 FAQ 판본의 체크섬이 다릅니다.')
    value = json.loads(payload)
    value['source'] = FaqEntry.model_validate(value['source'])
    value['chunks'] = tuple(FaqChunk(**chunk) for chunk in value['chunks'])
    return FaqDocuments(**value)


class FaqIndexState:
    def __init__(self, events: FaqEventStore, *, collection: str, model: str, dimensions: int):
        if not collection.strip() or not model.strip() or type(dimensions) is not int or dimensions < 1:
            raise ValueError('FAQ 색인 저장 설정이 올바르지 않습니다.')
        self.events, self.collection, self.model, self.dimensions = events, collection, model, dimensions
        with events.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('CREATE TABLE IF NOT EXISTS faq_index_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
            db.execute('''CREATE TABLE IF NOT EXISTS faq_active_sources (
                faq_id TEXT PRIMARY KEY,payload TEXT NOT NULL,checksum TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS faq_embedding_cache (
                input_hash TEXT PRIMARY KEY,model TEXT NOT NULL,dimensions INTEGER NOT NULL,
                input_text TEXT NOT NULL,vector TEXT NOT NULL,checksum TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS faq_cache_refs (
                faq_id TEXT NOT NULL,input_hash TEXT NOT NULL,PRIMARY KEY(faq_id,input_hash))''')
            config = _json({'schema': 1, 'format': FORMAT, 'collection': collection, 'model': model, 'dimensions': dimensions})
            old = db.execute("SELECT value FROM faq_index_meta WHERE key='config'").fetchone()
            if old is not None and old['value'] != config:
                raise ValueError('저장된 FAQ 색인의 모델/차원/컬렉션/형식이 다릅니다.')
            db.execute("INSERT OR IGNORE INTO faq_index_meta VALUES('config',?)", (config,))
            db.execute("INSERT OR IGNORE INTO faq_index_meta VALUES('generation','0')")
            db.commit()

    def read(self, *, exclude_blocked=False):
        with self.events.connect() as db:
            # 세대와 원문을 같은 SQLite 읽기 스냅샷에서 가져온다.
            db.execute('BEGIN')
            generation = int(db.execute("SELECT value FROM faq_index_meta WHERE key='generation'").fetchone()[0])
            rows = db.execute('SELECT faq_id,payload,checksum FROM faq_active_sources ORDER BY faq_id').fetchall()
            if exclude_blocked:
                blocked = {row[0] for row in db.execute('SELECT faq_id FROM faq_delete_blocks')}
                # 삭제는 본문을 해석하지 않아도 가능해야 한다. 손상된 삭제 대상도 건너뛴다.
                rows = [row for row in rows if row['faq_id'] not in blocked]
            items = tuple(_decode_faq(row['payload'], row['checksum']) for row in rows)
            if any(row['faq_id'] != item.faq_id for row, item in zip(rows, items, strict=True)):
                raise ValueError('FAQ 관리번호와 저장된 원문이 다릅니다.')
            db.commit()
            return generation, items

    def cached(self, chunk: FaqChunk):
        self.check_chunk(chunk)
        with self.events.connect() as db:
            row = db.execute('SELECT * FROM faq_embedding_cache WHERE input_hash=?', (chunk.embedding_sha256,)).fetchone()
        if row is None:
            return None
        if (row['model'], row['dimensions'], row['input_text']) != (self.model, self.dimensions, chunk.embedding_text):
            raise ValueError('임베딩 캐시와 실제 입력이 다릅니다.')
        if _checksum(row['vector']) != row['checksum']:
            raise ValueError('임베딩 캐시 체크섬이 다릅니다.')
        return checked_vector(json.loads(row['vector']), self.dimensions)

    def check_chunk(self, chunk):
        if (chunk.embedding_model, chunk.dimensions) != (self.model, self.dimensions):
            raise ValueError('청크와 활성 임베딩 설정이 다릅니다.')
        expected = _checksum(_json({'format': FORMAT, 'model': self.model, 'dimensions': self.dimensions,
                                    'text': chunk.embedding_text}))
        if chunk.embedding_sha256 != expected:
            raise ValueError('청크의 임베딩 입력 해시가 다릅니다.')

    def cache(self, pairs):
        values = []
        for chunk, vector in pairs:
            self.check_chunk(chunk)
            encoded = _json(checked_vector(vector, self.dimensions))
            values.append((chunk, encoded))
        with self.events.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for chunk, encoded in values:
                db.execute('INSERT OR IGNORE INTO faq_embedding_cache VALUES(?,?,?,?,?,?)',
                    (chunk.embedding_sha256, self.model, self.dimensions, chunk.embedding_text, encoded, _checksum(encoded)))
                db.execute('INSERT OR IGNORE INTO faq_cache_refs VALUES(?,?)', (chunk.faq_id, chunk.embedding_sha256))
            db.commit()

    def reference_cached(self, chunks):
        with self.events.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            for chunk in chunks:
                exists = db.execute('SELECT 1 FROM faq_embedding_cache WHERE input_hash=?', (chunk.embedding_sha256,)).fetchone()
                if exists is None:
                    raise ValueError('재사용할 벡터 캐시가 없습니다.')
                db.execute('INSERT OR IGNORE INTO faq_cache_refs VALUES(?,?)', (chunk.faq_id, chunk.embedding_sha256))
            db.commit()

    def commit(self, items, *, expected_generation, delete_ids=()):
        payloads = [(item.faq_id, _encode_faq(item)) for item in items]
        if len({key for key, _ in payloads}) != len(payloads):
            raise ValueError('활성 원문의 FAQ 번호가 중복됩니다.')
        with self.events.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            generation = int(db.execute("SELECT value FROM faq_index_meta WHERE key='generation'").fetchone()[0])
            if generation != expected_generation:
                raise RuntimeError('다른 작업이 FAQ 판본을 먼저 변경했습니다.')
            blocked = {row[0] for row in db.execute('SELECT faq_id FROM faq_delete_blocks')}
            if blocked.intersection(key for key, _ in payloads):
                raise FaqDeletionChanged('삭제된 FAQ를 후보 판본에서 제외해야 합니다.')
            db.execute('DELETE FROM faq_active_sources')
            db.executemany('INSERT INTO faq_active_sources VALUES(?,?,?)',
                           [(key, payload, _checksum(payload)) for key, payload in payloads])
            if delete_ids:
                keys = deletion_keys(delete_ids)
                if not set(keys).issubset(blocked):
                    raise ValueError('반환 차단 없이 FAQ 삭제를 완료할 수 없습니다.')
                db.executemany('DELETE FROM faq_cache_refs WHERE faq_id=?', [(key,) for key in keys])
                db.execute('''DELETE FROM faq_embedding_cache WHERE NOT EXISTS (
                    SELECT 1 FROM faq_cache_refs r WHERE r.input_hash=faq_embedding_cache.input_hash)''')
                db.executemany("UPDATE faq_delete_blocks SET status='CLEANED' WHERE faq_id=?", [(key,) for key in keys])
            db.execute("UPDATE faq_index_meta SET value=? WHERE key='generation'", (str(generation+1),))
            db.commit()
            return generation+1
