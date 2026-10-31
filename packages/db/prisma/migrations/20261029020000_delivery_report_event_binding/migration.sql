BEGIN;

CREATE UNIQUE INDEX delivery_events_owner_id_step_id_id_key ON delivery_events(owner_id, step_id, id);
CREATE UNIQUE INDEX delivery_step_reports_owner_id_step_id_event_id_key ON delivery_step_reports(owner_id, step_id, event_id);
ALTER TABLE delivery_step_reports DROP CONSTRAINT delivery_step_reports_owner_id_event_id_fkey;
ALTER TABLE delivery_step_reports ADD CONSTRAINT delivery_step_reports_owner_id_step_id_event_id_fkey
FOREIGN KEY (owner_id, step_id, event_id) REFERENCES delivery_events(owner_id, step_id, id)
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE delivery_steps ADD CONSTRAINT delivery_acceptance_phase
CHECK (acceptance_phase IN ('implementation_preview', 'activation_production'));

COMMIT;
