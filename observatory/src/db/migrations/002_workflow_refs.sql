-- Workflow drafts gain provenance: what produced this draft.
-- Without it, a scheduled pass re-creates the same site-change record on every run, because
-- there is no way to ask "did we already draft something for this detection?".
ALTER TABLE workflow_drafts ADD COLUMN ref_type TEXT;
ALTER TABLE workflow_drafts ADD COLUMN ref_id   TEXT;

-- One draft per (kind, source object). Partial index so drafts without provenance are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_ref
  ON workflow_drafts (kind, ref_type, ref_id)
  WHERE ref_id IS NOT NULL;

-- Scheduling state per source: how often to collect, and when it last ran.
ALTER TABLE sources ADD COLUMN schedule_minutes INTEGER NOT NULL DEFAULT 1440;
ALTER TABLE sources ADD COLUMN next_run_at TEXT;
