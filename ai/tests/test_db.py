"""테스트용 PostgreSQL(TEST_DATABASE_URL)에서 돈다. 없으면 건너뛴다. 테스트마다 데이터를 비운다."""

import asyncio
import os

import pytest
from conftest import CALLER, FULL_ORDER, run

from app.db import Database
from app.order import Order, Place

URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL 없음")

ORDER = Order(**{**FULL_ORDER, "sender_phone": CALLER, "receiver_phone": "01098765432"})
OTHER = "01099999999"


def with_db(test):
    async def body():
        db = Database(URL, 1, 10)
        await db.open()
        try:
            async with db.pool.connection() as conn:
                await conn.execute("TRUNCATE orders, saved_places RESTART IDENTITY")
                await conn.execute("ALTER SEQUENCE order_no_seq RESTART")
            await test(db)
        finally:
            await db.close()

    run(body())


def test_concurrent_inserts_get_unique_order_numbers():
    async def test(db):
        nos = await asyncio.gather(*(db.insert_order(CALLER, f"s{i}", ORDER, 3500, "Q") for i in range(30)))
        assert len(set(nos)) == 30 and all(n.startswith("Q") and len(n) == 7 for n in nos)

    with_db(test)


def test_orders_scoped_to_caller():
    async def test(db):
        mine = await db.insert_order(CALLER, "s", ORDER, 3500, "Q")
        other = await db.insert_order(OTHER, "s", ORDER, 3500, "Q")
        assert [o["order_no"] for o in await db.list_orders(CALLER, 5)] == [mine]
        assert not await db.update_order(CALLER, other, {"item": "책"})
        assert not await db.cancel_order(CALLER, other)
        assert await db.update_order(CALLER, mine, {"item": "책", "drop_table": "x"})
        assert (await db.list_orders(CALLER, 5))[0]["item"] == "책"
        assert not await db.update_order(CALLER, mine, {"status": "cancelled"})  # 정해진 컬럼만
        assert (await db.latest_receiver(CALLER)).name == "이영희"
        assert await db.cancel_order(CALLER, mine)
        assert not await db.cancel_order(CALLER, mine)
        assert await db.latest_receiver(CALLER) is None
        assert not await db.update_order(CALLER, mine, {"item": "x"})  # 취소된 주문은 못 고친다

    with_db(test)


def test_sql_values_are_bound_not_interpolated():
    async def test(db):
        evil = Order(**{**ORDER.model_dump(), "item": "'); DROP TABLE orders; --"})
        no = await db.insert_order(CALLER, "s", evil, 3500, "Q")
        assert (await db.list_orders(CALLER, 1))[0]["item"] == evil.item
        assert (await db.recent_orders(10))[0]["order_no"] == no

    with_db(test)


def test_saved_places_scoped_and_deduplicated():
    async def test(db):
        p = Place(name="김철수", phone=CALLER, address="서울", address_detail="")
        assert await db.save_places(CALLER, [p, Place(name="이영희", phone="0", address="부산", address_detail="1")]) == 2
        assert await db.save_places(CALLER, [p]) == 0
        assert [x.name for x in await db.list_places(CALLER)] == ["김철수", "이영희"]
        assert await db.list_places(OTHER) == []

    with_db(test)
