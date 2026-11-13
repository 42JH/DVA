ALTER TABLE calls DROP CONSTRAINT calls_status_check;

ALTER TABLE calls ADD CONSTRAINT calls_status_check
  CHECK (status IN ('REQUESTED', 'ACCEPTED', 'REJECTED', 'CANCELED', 'ENDED', 'EXPIRED'));

ALTER TABLE calls ADD COLUMN accepted_at timestamptz;

-- Requests from the previous version did not have a receiving client.
UPDATE calls SET status = 'EXPIRED' WHERE status = 'REQUESTED';

CREATE UNIQUE INDEX calls_one_active_pair ON calls (
  least(caller_id, callee_id), greatest(caller_id, callee_id)
) WHERE status IN ('REQUESTED', 'ACCEPTED');
