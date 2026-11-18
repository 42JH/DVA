ALTER TABLE personal_pins ADD COLUMN deleted_at timestamptz;
DROP INDEX personal_pins_identity_uk;
CREATE UNIQUE INDEX personal_pins_identity_uk ON personal_pins(customer_seq,pin_identity(address_data))
 WHERE deleted_at IS NULL;
CREATE INDEX personal_pins_retention_idx ON personal_pins(deleted_at) WHERE deleted_at IS NOT NULL;
