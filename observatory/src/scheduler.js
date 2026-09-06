'use strict';
const { now, json } = require('./core/util');
const { all, get, run } = require('./db');
const { logger } = require('./core/log');
const jobs = require('./core/jobs');

const log = logger('scheduler');

/**
 * Decides what work is due and puts it on the queue. Nothing here executes collection or
 * curation — that is the workers' job. Splitting the two means a slow source cannot delay
 * the rest of the pipeline, and a crashed worker loses a job rather than a whole pass.
 *
 * Cadence lives on the source (`schedule_minutes`), so a fast-moving connector and a quarterly
 * document import can share one scheduler without either dictating the other's rhythm.
 */

const MINUTE = 60000;

/** Sources whose next run is due (or which have never run). */
function dueSources(db, at = now()) {
  return all(db, `SELECT * FROM sources WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)`, at);
}

function markScheduled(db, source, at = now()) {
  const minutes = source.schedule_minutes || 1440;
  const next = new Date(new Date(at).getTime() + minutes * MINUTE).toISOString();
  run(db, 'UPDATE sources SET next_run_at = ? WHERE id = ?', next, source.id);
  return next;
}

/**
 * Enqueues one collection job per due source, then the downstream stages once.
 * Idempotent within a tick: a source already holding a pending collect job is skipped, so
 * running the scheduler on a short interval cannot pile up duplicate work.
 */
function tick(db, { at = now(), includeDownstream = true } = {}) {
  const queued = { collect: 0, downstream: 0, skipped: 0 };

  for (const source of dueSources(db, at)) {
    const pending = get(db, `SELECT id FROM jobs WHERE type = 'collect' AND state IN ('pending','running')
                             AND payload_json LIKE ?`, `%"${source.id}"%`);
    if (pending) { queued.skipped += 1; continue; }
    jobs.enqueue(db, 'collect', { sourceId: source.id });
    markScheduled(db, source, at);
    queued.collect += 1;
  }

  // Downstream stages are cheap and idempotent; queue one pass when anything was collected
  // or when explicitly asked, rather than one per source.
  if (includeDownstream && queued.collect > 0) {
    for (const type of ['curate', 'status', 'trends', 'graph']) {
      const pending = get(db, `SELECT id FROM jobs WHERE type = ? AND state = 'pending'`, type);
      if (pending) continue;
      jobs.enqueue(db, type, {});
      queued.downstream += 1;
    }
  }

  if (queued.collect || queued.downstream) log.info('scheduled work', queued);
  return queued;
}

/** Sets a source's cadence in minutes. */
function setSchedule(db, sourceId, minutes) {
  run(db, 'UPDATE sources SET schedule_minutes = ?, next_run_at = NULL WHERE id = ?', minutes, sourceId);
  return { sourceId, minutes };
}

const upcoming = (db) =>
  all(db, `SELECT id, name, collector, schedule_minutes, next_run_at FROM sources WHERE enabled = 1
           ORDER BY COALESCE(next_run_at, '')`)
    .map((s) => ({ ...s, config: undefined, freshness_hours: json(s.config_json, {}).freshness_hours }));

module.exports = { tick, dueSources, markScheduled, setSchedule, upcoming };
