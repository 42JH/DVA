"""DB 접근은 이 모듈 하나에. 값은 항상 파라미터 바인딩, 컬럼 이름은 정해진 목록(ORDER_FIELDS)으로만."""

from pathlib import Path

from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.order import ORDER_FIELDS, Order, Place

SCHEMA = Path(__file__).with_name("schema.sql")
_ORDER_COLS = sql.SQL(", ").join(map(sql.Identifier, ORDER_FIELDS))
_LIST_COLS = "order_no, receiver_name, receiver_address, item, fare, status, created_at"


class Database:
    def __init__(self, url: str, min_size: int = 1, max_size: int = 10):
        self.pool = AsyncConnectionPool(url, min_size=min_size, max_size=max_size, open=False,
                                        kwargs={"row_factory": dict_row})

    async def open(self) -> None:
        await self.pool.open(wait=True)
        async with self.pool.connection() as conn:
            await conn.execute(SCHEMA.read_text(encoding="utf-8"))

    async def close(self) -> None:
        await self.pool.close()

    async def insert_order(self, caller: str | None, session_id: str, order: Order, fare: int, prefix: str) -> str:
        """접수번호 발급과 저장을 한 문장(한 트랜잭션)으로. 시퀀스라 동시 접수에서도 겹치지 않는다."""
        values = [getattr(order, f) for f in ORDER_FIELDS]
        query = sql.SQL(
            "INSERT INTO orders (order_no, caller_phone, session_id, fare, {cols}) "
            "VALUES (%s || lpad(nextval('order_no_seq')::text, 6, '0'), %s, %s, %s, {ph}) RETURNING order_no"
        ).format(cols=_ORDER_COLS, ph=sql.SQL(", ").join(sql.Placeholder() * len(values)))
        async with self.pool.connection() as conn:
            row = await (await conn.execute(query, [prefix, caller, session_id, fare, *values])).fetchone()
        return row["order_no"]

    async def list_orders(self, caller: str, limit: int) -> list[dict]:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                f"SELECT {_LIST_COLS} FROM orders WHERE caller_phone = %s ORDER BY created_at DESC, id DESC LIMIT %s",
                [caller, limit])
            rows = await cur.fetchall()
        for r in rows:
            r["created_at"] = r["created_at"].isoformat(timespec="minutes")
        return rows

    async def latest_receiver(self, caller: str) -> Place | None:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT receiver_name AS name, receiver_phone AS phone, receiver_address AS address, "
                "receiver_address_detail AS address_detail FROM orders "
                "WHERE caller_phone = %s AND status = 'received' ORDER BY created_at DESC, id DESC LIMIT 1",
                [caller])
            row = await cur.fetchone()
        return Place(**row) if row else None

    async def update_order(self, caller: str, order_no: str, values: dict[str, str]) -> bool:
        cols = [c for c in values if c in ORDER_FIELDS]
        if not cols:
            return False
        query = sql.SQL(
            "UPDATE orders SET {sets}, updated_at = now() "
            "WHERE order_no = %s AND caller_phone = %s AND status = 'received'"
        ).format(sets=sql.SQL(", ").join(sql.SQL("{} = %s").format(sql.Identifier(c)) for c in cols))
        async with self.pool.connection() as conn:
            cur = await conn.execute(query, [*(values[c] for c in cols), order_no, caller])
            return cur.rowcount == 1

    async def cancel_order(self, caller: str, order_no: str) -> bool:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "UPDATE orders SET status = 'cancelled', updated_at = now() "
                "WHERE order_no = %s AND caller_phone = %s AND status = 'received'",
                [order_no, caller])
            return cur.rowcount == 1

    async def list_places(self, owner: str) -> list[Place]:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT name, phone, address, address_detail FROM saved_places WHERE owner_phone = %s ORDER BY id",
                [owner])
            return [Place(**r) for r in await cur.fetchall()]

    async def save_places(self, owner: str, places: list[Place]) -> int:
        saved = 0
        async with self.pool.connection() as conn:
            for p in places:
                cur = await conn.execute(
                    "INSERT INTO saved_places (owner_phone, name, phone, address, address_detail) "
                    "VALUES (%s, %s, %s, %s, %s) ON CONFLICT DO NOTHING",
                    [owner, p.name, p.phone, p.address, p.address_detail])
                saved += cur.rowcount
        return saved

    async def recent_orders(self, limit: int) -> list[dict]:
        """관제 화면용 접수 주문 목록."""
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT order_no, caller_phone, status, fare, created_at, {} FROM orders "
                "ORDER BY id DESC LIMIT %s".format(", ".join(ORDER_FIELDS)), [limit])
            rows = await cur.fetchall()
        for r in rows:
            r["created_at"] = r["created_at"].isoformat(timespec="seconds")
        return rows
