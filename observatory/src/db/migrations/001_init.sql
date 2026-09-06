-- Observatory core schema.
-- One file per stage of the infrastructure map, in pipeline order:
--   source systems -> collection -> staging + curation -> curated stores -> reasoning + outputs
-- SQLite dialect, kept Postgres-portable (no AUTOINCREMENT, TEXT ids, ISO-8601 timestamps).

-- ── SOURCE SYSTEMS ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,           -- public_web|files_media|marketing_api|client_system|internal_knowledge
  name         TEXT NOT NULL,
  collector    TEXT NOT NULL,           -- scraper|file_importer|api_connector|client_indexer|knowledge_import
  config_json  TEXT NOT NULL DEFAULT '{}',
  trust        REAL NOT NULL DEFAULT 0.5,   -- 0..1 prior on how much this source is believed
  rate_limit_per_min INTEGER NOT NULL DEFAULT 30,
  enabled      INTEGER NOT NULL DEFAULT 1,
  client_id    TEXT,                    -- set for client_system sources
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'standard',
  created_at TEXT NOT NULL
);

-- ── COLLECTION ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS collection_runs (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id),
  collector   TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',  -- running|ok|failed
  items       INTEGER NOT NULL DEFAULT 0,
  cost_cents  INTEGER NOT NULL DEFAULT 0,
  latency_ms  INTEGER,
  error       TEXT
);

-- Raw landing zone. Payloads stay here; curated stores hold refs + snippets, not raw.
CREATE TABLE IF NOT EXISTS staging_artifacts (
  id             TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL REFERENCES sources(id),
  run_id         TEXT REFERENCES collection_runs(id),
  uri            TEXT,
  media_type     TEXT NOT NULL DEFAULT 'text/plain',
  content_hash   TEXT NOT NULL,
  payload_json   TEXT NOT NULL DEFAULT '{}',
  raw_ref        TEXT,                  -- pointer to offloaded blob (media/OCR/transcription)
  parser         TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  cost_cents     INTEGER NOT NULL DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'new'  -- new|curated|rejected
);
CREATE INDEX IF NOT EXISTS idx_artifacts_state ON staging_artifacts(state);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_hash ON staging_artifacts(source_id, content_hash);

CREATE TABLE IF NOT EXISTS source_health (
  source_id     TEXT NOT NULL REFERENCES sources(id),
  window_start  TEXT NOT NULL,
  ok_count      INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  cost_cents    INTEGER NOT NULL DEFAULT 0,
  last_success  TEXT,
  PRIMARY KEY (source_id, window_start)
);

-- ── STAGING + CURATION ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candidates (
  id           TEXT PRIMARY KEY,
  artifact_id  TEXT NOT NULL REFERENCES staging_artifacts(id),
  domain       TEXT,                    -- seo|paid_ads|social|local_business|ai|web_design|unrouted
  kind         TEXT NOT NULL,           -- fact|sop|experiment|metric|signal|doc|question
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  fingerprint  TEXT NOT NULL,           -- normalized-content hash, used for dedupe
  duplicate_of TEXT REFERENCES candidates(id),
  client_id    TEXT REFERENCES clients(id),
  trust        REAL NOT NULL DEFAULT 0,
  risk         REAL NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'pending', -- pending|duplicate|in_review|promoted|declined
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_state ON candidates(state);
CREATE INDEX IF NOT EXISTS idx_candidates_fingerprint ON candidates(fingerprint);

CREATE TABLE IF NOT EXISTS review_queue (
  id           TEXT PRIMARY KEY,
  candidate_id TEXT REFERENCES candidates(id),
  kb_entry_id  TEXT,
  reason       TEXT NOT NULL,           -- low_trust|high_risk|contradiction|supersession|unrouted|escalated
  severity     TEXT NOT NULL DEFAULT 'normal', -- normal|critical
  detail       TEXT,
  assigned_to  TEXT,
  state        TEXT NOT NULL DEFAULT 'open',   -- open|decided
  created_at   TEXT NOT NULL,
  decided_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_state ON review_queue(state);

CREATE TABLE IF NOT EXISTS review_decisions (
  id         TEXT PRIMARY KEY,
  review_id  TEXT NOT NULL REFERENCES review_queue(id),
  decision   TEXT NOT NULL,             -- accepted|accepted_with_detail|declined|critical|legacy|superseded
  detail     TEXT,
  rationale  TEXT,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Every state transition in the pipeline lands here. Nothing is promoted silently.
CREATE TABLE IF NOT EXISTS promotion_audit (
  id          TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  actor       TEXT NOT NULL,            -- worker name or human id
  reason      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_object ON promotion_audit(object_type, object_id);

-- ── CURATED STORES ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kb_entries (
  id            TEXT PRIMARY KEY,
  domain        TEXT NOT NULL,
  type          TEXT NOT NULL,          -- fact|sop|experiment|playbook|case_study
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'current', -- current|legacy|superseded
  version       INTEGER NOT NULL DEFAULT 1,
  supersedes_id TEXT REFERENCES kb_entries(id),
  client_scope  TEXT NOT NULL DEFAULT 'shared',  -- 'shared' or a client id
  confidence    REAL NOT NULL DEFAULT 0.5,
  candidate_id  TEXT REFERENCES candidates(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_domain_status ON kb_entries(domain, status);

CREATE TABLE IF NOT EXISTS client_corpus (
  id            TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL REFERENCES clients(id),
  kind          TEXT NOT NULL,          -- meeting|email|task|doc|sales|icp|form|report
  title         TEXT NOT NULL,
  snippet       TEXT NOT NULL,          -- snippet only; raw stays in staging behind source_ref
  source_ref    TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  access_json   TEXT NOT NULL DEFAULT '{}',  -- row-level access parameters
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corpus_client ON client_corpus(client_id);

CREATE TABLE IF NOT EXISTS claims (
  id            TEXT PRIMARY KEY,
  statement     TEXT NOT NULL,
  kb_entry_id   TEXT REFERENCES kb_entries(id),
  domain        TEXT,
  confidence    REAL NOT NULL DEFAULT 0.5,
  asserted_at   TEXT NOT NULL,
  freshness_at  TEXT NOT NULL           -- newest evidence timestamp behind this claim
);

CREATE TABLE IF NOT EXISTS citations (
  id          TEXT PRIMARY KEY,
  claim_id    TEXT NOT NULL REFERENCES claims(id),
  artifact_id TEXT REFERENCES staging_artifacts(id),
  source_id   TEXT NOT NULL REFERENCES sources(id),
  locator     TEXT,
  quote       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_citations_claim ON citations(claim_id);

-- Append-only recorder of neutral watched signals. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS market_activity (
  id          TEXT PRIMARY KEY,
  observed_at TEXT NOT NULL,
  channel     TEXT NOT NULL,            -- serp|platform|competitor|ads|social
  subject     TEXT NOT NULL,
  signal      TEXT NOT NULL,
  value       REAL,
  unit        TEXT,
  source_id   TEXT REFERENCES sources(id),
  artifact_id TEXT REFERENCES staging_artifacts(id),
  meta_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_market_subject ON market_activity(subject, signal, observed_at);

CREATE TABLE IF NOT EXISTS inquiries (
  id          TEXT PRIMARY KEY,
  question    TEXT NOT NULL,
  origin      TEXT NOT NULL,            -- human|ai
  status      TEXT NOT NULL DEFAULT 'open', -- open|watching|experiment|answered|closed
  domain      TEXT,
  client_id   TEXT REFERENCES clients(id),
  created_by  TEXT,
  created_at  TEXT NOT NULL,
  answered_at TEXT,
  answer      TEXT
);

CREATE TABLE IF NOT EXISTS trend_detections (
  id            TEXT PRIMARY KEY,
  detected_at   TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- pattern|anomaly|correlation
  domain        TEXT,
  subject       TEXT NOT NULL,
  summary       TEXT NOT NULL,
  score         REAL NOT NULL,
  window_start  TEXT,
  window_end    TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  action        TEXT NOT NULL DEFAULT 'watch', -- watch|experiment|review|none
  state         TEXT NOT NULL DEFAULT 'new'    -- new|watching|reviewed|dismissed
);

CREATE TABLE IF NOT EXISTS trend_watchlist (
  id           TEXT PRIMARY KEY,
  detection_id TEXT REFERENCES trend_detections(id),
  subject      TEXT NOT NULL,
  added_at     TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'active'
);

-- ── REASONING + OUTPUTS ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reasoning_runs (
  id              TEXT PRIMARY KEY,
  question        TEXT NOT NULL,
  client_id       TEXT,
  principal_json  TEXT NOT NULL,
  output_json     TEXT NOT NULL,
  supported       INTEGER NOT NULL DEFAULT 0,
  unsupported     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_drafts (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,          -- tallyfy_draft|recommended_action|site_change
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  client_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|approved|rejected|dispatched
  run_id        TEXT REFERENCES reasoning_runs(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS annotations (
  id          TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note', -- note|rationale|approval|platform_review
  note        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_object ON annotations(object_type, object_id);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,           -- weekly_market_brief|report_safe_view
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  safe         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS opportunity_briefs (
  id                TEXT PRIMARY KEY,
  client_id         TEXT,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  proof_points_json TEXT NOT NULL DEFAULT '[]',
  public_safe       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_nodes (
  id     TEXT PRIMARY KEY,
  type   TEXT NOT NULL,                 -- kb_entry|client|source|claim|trend|inquiry
  ref_id TEXT NOT NULL,
  label  TEXT NOT NULL,
  UNIQUE (type, ref_id)
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id     TEXT PRIMARY KEY,
  src_id TEXT NOT NULL REFERENCES graph_nodes(id),
  dst_id TEXT NOT NULL REFERENCES graph_nodes(id),
  rel    TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  UNIQUE (src_id, dst_id, rel)
);

-- ── PLUMBING ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  run_after    TEXT NOT NULL,
  last_error   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, run_after);
