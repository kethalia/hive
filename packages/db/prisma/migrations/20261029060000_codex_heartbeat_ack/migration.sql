-- Exact latest signed-heartbeat retry can recover an acknowledgement without
-- extending the registration lease. Old rows have no replayable acknowledgement.
ALTER TABLE "codex_host_registrations" ADD COLUMN "heartbeat_request_digest" TEXT;
