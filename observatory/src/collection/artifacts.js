'use strict';
const { id, now, sha256 } = require('../core/util');
const { run, get } = require('../db');

/** Opens a collection run. Every collector wraps its work in start/finish so cost and health are always logged. */
function startRun(db, source, collector) {
  const runId = id('run');
  run(db, `INSERT INTO collection_runs (id, source_id, collector, started_at, status) VALUES (?, ?, ?, ?, 'running')`,
    runId, source.id, collector, now());
  return runId;
}

function finishRun(db, runId, { status = 'ok', items = 0, costCents = 0, latencyMs = null, error = null } = {}) {
  run(db, `UPDATE collection_runs SET finished_at = ?, status = ?, items = ?, cost_cents = ?, latency_ms = ?, error = ?
           WHERE id = ?`,
    now(), status, items, costCents, latencyMs, error, runId);
  const source = get(db, 'SELECT source_id FROM collection_runs WHERE id = ?', runId);
  if (source) recordHealth(db, source.source_id, status === 'ok', costCents);
  return runId;
}

/** Rolling daily health window per source: what the staging schema's "source health" box tracks. */
function recordHealth(db, sourceId, ok, costCents = 0) {
  const window = now().slice(0, 10);
  run(db, `INSERT INTO source_health (source_id, window_start, ok_count, fail_count, cost_cents, last_success)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (source_id, window_start) DO UPDATE SET
             ok_count   = ok_count   + excluded.ok_count,
             fail_count = fail_count + excluded.fail_count,
             cost_cents = cost_cents + excluded.cost_cents,
             last_success = COALESCE(excluded.last_success, source_health.last_success)`,
    sourceId, window, ok ? 1 : 0, ok ? 0 : 1, costCents, ok ? now() : null);
}

/**
 * Writes one raw artifact into staging.
 * Returns { artifactId, duplicate } — a repeat fetch of unchanged content is a no-op,
 * so collectors can run on a schedule without inflating the queue.
 */
function writeArtifact(db, {
  sourceId, runId, uri = null, mediaType = 'text/plain', payload = {},
  raw = null, rawRef = null, parser, parserVersion = '1.0.0', costCents = 0, fetchedAt = null,
}) {
  const content = raw != null ? String(raw) : JSON.stringify(payload);
  const hash = sha256(content);
  const existing = get(db, 'SELECT id FROM staging_artifacts WHERE source_id = ? AND content_hash = ?', sourceId, hash);
  if (existing) return { artifactId: existing.id, duplicate: true };

  const artifactId = id('art');
  run(db, `INSERT INTO staging_artifacts
             (id, source_id, run_id, uri, media_type, content_hash, payload_json, raw_ref,
              parser, parser_version, fetched_at, cost_cents, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    artifactId, sourceId, runId, uri, mediaType, hash, JSON.stringify(payload), rawRef,
    parser, parserVersion, fetchedAt || now(), costCents);
  return { artifactId, duplicate: false };
}

module.exports = { startRun, finishRun, recordHealth, writeArtifact };
