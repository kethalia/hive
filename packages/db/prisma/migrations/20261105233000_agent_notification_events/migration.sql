-- Additive source-owned agent event ingress. Existing hook credentials remain untouched.
CREATE UNIQUE INDEX notification_sources_user_id_id_key ON notification_sources(user_id,id);
CREATE TABLE agent_notification_events (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, source_id uuid NOT NULL,
 event_id uuid NOT NULL UNIQUE, event_key text NOT NULL, payload jsonb NOT NULL,
 payload_digest text NOT NULL, coder_user_id uuid NOT NULL, coder_origin text NOT NULL,
 channel text NOT NULL DEFAULT 'push', status text NOT NULL DEFAULT 'pending',
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT agent_notification_source_owner_fk FOREIGN KEY(owner_id,source_id)
   REFERENCES notification_sources(user_id,id) ON DELETE CASCADE ON UPDATE NO ACTION,
 CONSTRAINT agent_notification_event_key UNIQUE(source_id,event_key),
 CONSTRAINT agent_notification_bounds CHECK (
   channel='push' AND status IN ('pending','processing','delivered','failed') AND attempts BETWEEN 0 AND 5
   AND event_key ~ '^[A-Za-z0-9_-]{1,100}$' AND payload_digest ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192
 )
);
CREATE INDEX agent_notification_events_status_due_idx ON agent_notification_events(status,next_attempt_at);
CREATE INDEX agent_notification_events_owner_due_idx ON agent_notification_events(owner_id,status,next_attempt_at);
CREATE INDEX agent_notification_events_source_status_idx ON agent_notification_events(source_id,status);
CREATE TABLE agent_notification_rate_windows (
 source_id uuid PRIMARY KEY, owner_id uuid NOT NULL, window_start timestamptz NOT NULL,
 accepted integer NOT NULL CHECK(accepted BETWEEN 1 AND 60),
 CONSTRAINT agent_notification_rate_owner_source_key UNIQUE(owner_id,source_id),
 CONSTRAINT agent_notification_rate_owner_fk FOREIGN KEY(owner_id,source_id)
   REFERENCES notification_sources(user_id,id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE FUNCTION hive_agent_notification_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
   IF NEW.status<>'pending' OR NEW.attempts<>0 THEN RAISE EXCEPTION 'agent notice starts pending'; END IF;
 ELSIF OLD.status IN ('delivered','failed') OR
   (to_jsonb(NEW)-ARRAY['status','attempts','next_attempt_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['status','attempts','next_attempt_at']) OR
   NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1 THEN
   RAISE EXCEPTION 'agent notice identity/history is immutable';
 ELSIF NEW.attempts=OLD.attempts+1 THEN
   IF NEW.status<>'processing' OR OLD.next_attempt_at>clock_timestamp() THEN
     RAISE EXCEPTION 'agent notice claim is fenced';
   END IF;
 ELSIF NOT ((OLD.status='processing' AND NEW.status IN ('pending','delivered','failed')) OR (OLD.status='pending' AND OLD.attempts=5 AND NEW.status='failed')) THEN
   RAISE EXCEPTION 'agent notice settlement requires a current processing claim';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_notification_immutable BEFORE INSERT OR UPDATE ON agent_notification_events
 FOR EACH ROW EXECUTE FUNCTION hive_agent_notification_immutable();
REVOKE ALL ON agent_notification_events,agent_notification_rate_windows FROM PUBLIC;
DO $$ DECLARE runtime_role text; BEGIN
 FOREACH runtime_role IN ARRAY ARRAY['hive_app_runtime','hive_native_runtime'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
     EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON agent_notification_events,agent_notification_rate_windows TO %I',runtime_role);
     EXECUTE format('REVOKE TRUNCATE,REFERENCES,TRIGGER ON agent_notification_events,agent_notification_rate_windows FROM %I',runtime_role);
   END IF;
 END LOOP;
END $$;
