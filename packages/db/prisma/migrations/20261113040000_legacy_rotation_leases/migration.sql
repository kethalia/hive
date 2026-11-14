-- Legacy password/session credentials keep their existing encryption and version CAS.
ALTER TABLE coder_tokens
  ADD COLUMN rotation_next_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN rotation_lease_id uuid,
  ADD COLUMN rotation_lease_until timestamptz,
  ADD COLUMN rotation_state jsonb,
  ADD COLUMN warning_next_at timestamptz,
  ADD CONSTRAINT coder_tokens_rotation_lease_pair CHECK (
    (rotation_lease_id IS NULL) = (rotation_lease_until IS NULL)
  ),
  ADD CONSTRAINT coder_tokens_rotation_state_bound CHECK (
    rotation_state IS NULL OR (jsonb_typeof(rotation_state)='object' AND octet_length(rotation_state::text)<=8192)
  );
CREATE INDEX coder_tokens_rotation_due_idx ON coder_tokens(rotation_next_at);
