-- Diagnostic metadata only; credentials and terminal content remain outside these tables.
CREATE TABLE terminal_connections (
 id uuid PRIMARY KEY, user_id uuid NOT NULL, coder_user_id uuid NOT NULL,
 coder_origin text NOT NULL, workspace_id uuid NOT NULL, build_id uuid NOT NULL,
 agent_id uuid NOT NULL, session_name text NOT NULL, session_kind text NOT NULL,
 authority_expires_at timestamptz NOT NULL, lease_until timestamptz NOT NULL,
 health jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, closed_at timestamptz,
 close_code integer, close_reason text,
 CONSTRAINT terminal_connection_bounds CHECK (
   session_kind IN ('git','terminal') AND session_name ~ '^[A-Za-z0-9._-]{1,200}$'
   AND lease_until <= authority_expires_at AND octet_length(health::text) <= 4096
   AND jsonb_typeof(health) = 'object'
 )
);
CREATE INDEX terminal_connections_owner_workspace_lease_idx
 ON terminal_connections(user_id,coder_origin,coder_user_id,workspace_id,lease_until);
CREATE INDEX terminal_connections_updated_at_idx ON terminal_connections(updated_at);
CREATE TABLE terminal_events (
 id bigserial PRIMARY KEY, user_id uuid NOT NULL, coder_user_id uuid NOT NULL,
 coder_origin text NOT NULL, workspace_id uuid NOT NULL, connection_id uuid NOT NULL,
 session_name text NOT NULL, session_kind text NOT NULL, level text NOT NULL,
 type text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT terminal_event_bounds CHECK (
   session_kind IN ('git','terminal') AND level IN ('info','warning','error')
   AND session_name ~ '^[A-Za-z0-9._-]{1,200}$' AND jsonb_typeof(details) = 'object'
   AND octet_length(details::text) <= 2048
 )
);
CREATE INDEX terminal_events_user_id_id_idx ON terminal_events(user_id,id);
CREATE INDEX terminal_events_created_at_idx ON terminal_events(created_at);
