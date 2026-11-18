CREATE TABLE payment_cards (
 payment_card_seq integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 customer_seq integer REFERENCES customers(customer_seq),
 organization_seq integer REFERENCES organizations(organization_seq),
 registration_key uuid NOT NULL UNIQUE,
 request_hash text NOT NULL,
 provider_customer_key uuid NOT NULL,
 provider_environment text NOT NULL CHECK(provider_environment IN ('test','live')),
 encrypted_billing_key text,
 issuer_code text,
 masked_number text,
 expiration_year integer NOT NULL CHECK(expiration_year BETWEEN 2000 AND 2099),
 expiration_month integer NOT NULL CHECK(expiration_month BETWEEN 1 AND 12),
 status text NOT NULL DEFAULT 'REGISTERING' CHECK(status IN ('REGISTERING','ACTIVE','FAILED')),
 claimed_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz,
 CHECK ((customer_seq IS NOT NULL)::int+(organization_seq IS NOT NULL)::int=1),
 CHECK(status<>'ACTIVE' OR deleted_at IS NOT NULL OR (encrypted_billing_key IS NOT NULL AND masked_number IS NOT NULL))
);
CREATE UNIQUE INDEX payment_cards_customer_active ON payment_cards(customer_seq) WHERE deleted_at IS NULL AND status='ACTIVE';
CREATE UNIQUE INDEX payment_cards_company_active ON payment_cards(organization_seq) WHERE deleted_at IS NULL AND status='ACTIVE';
CREATE INDEX payment_cards_deleted ON payment_cards(deleted_at) WHERE deleted_at IS NOT NULL;
