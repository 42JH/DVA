"""고객이 말한 주소를 행안부 주소DB의 실제 도로명주소로 바로잡는다(spec/address.md).
보정 로직은 corrector.py(kakao_map_test에서 옮김), DB 조회는 db.py. 기동 때 load()로 DB를 열고,
DB 파일이 없으면 보정을 끄고 들은 그대로 둔다(correct()가 None)."""

import asyncio
import logging
import threading
from pathlib import Path

from address_resolver.corrector import correct as _correct

log = logging.getLogger(__name__)

_db = None
_lock = threading.Lock()  # SQLite 연결 하나와 지역별 도로 캐시를 통화들이 같이 쓴다


def load(path: Path) -> bool:
    global _db
    if not path.is_file():
        log.warning("주소DB가 없어 주소 보정을 끕니다: %s", path)
        _db = None
        return False
    from address_resolver.db import AddressDB

    _db = AddressDB(path)
    log.info("주소 보정 켜짐: %s", path)
    return True


async def correct(text: str) -> dict | None:
    """{"status": "confirmed"|"ambiguous"|"not_found", "address", "candidates"}. 보정이 꺼져 있으면 None.
    SQLite 조회가 이벤트 루프를 막지 않게 스레드에서 돌린다."""
    if _db is None:
        return None
    return await asyncio.to_thread(_locked, text)


def correct_blocking(text: str) -> dict | None:
    """correct()의 동기판: 부르는 쪽이 자기 실행기에서 돌린다(app/integrations/address.py 전용 스레드풀)."""
    return None if _db is None else _locked(text)


def _locked(text: str) -> dict:
    with _lock:
        return _correct(_db, text)
