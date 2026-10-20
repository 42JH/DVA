-- 접수 주문·저장된 배송지. 서버 시작 시 실행해 맞춘다(마이그레이션 도구는 필요해질 때).

CREATE SEQUENCE IF NOT EXISTS order_no_seq;

CREATE TABLE IF NOT EXISTS orders (
    id                      bigserial PRIMARY KEY,
    order_no                text        NOT NULL UNIQUE,
    caller_phone            text,
    session_id              text        NOT NULL,
    sender_name             text        NOT NULL,
    sender_phone            text        NOT NULL,
    sender_address          text        NOT NULL,
    sender_address_detail   text        NOT NULL,
    receiver_name           text        NOT NULL,
    receiver_phone          text        NOT NULL,
    receiver_address        text        NOT NULL,
    receiver_address_detail text        NOT NULL,
    item                    text        NOT NULL,
    fare                    integer     NOT NULL,
    status                  text        NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'cancelled')),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_caller_phone_idx ON orders (caller_phone, created_at DESC);

CREATE TABLE IF NOT EXISTS saved_places (
    id             bigserial PRIMARY KEY,
    owner_phone    text        NOT NULL,
    name           text        NOT NULL,
    phone          text        NOT NULL,
    address        text        NOT NULL,
    address_detail text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_phone, name, phone, address, address_detail)
);

CREATE INDEX IF NOT EXISTS saved_places_owner_phone_idx ON saved_places (owner_phone);
