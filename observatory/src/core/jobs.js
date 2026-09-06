'use strict';
const { id, now, json } = require('./util');
const { run, get, all } = require('../db');
const { logger } = require('./log');

const log = logger('jobs');

/**
 * Minimal in-database work queue. Enough to run the pipeline as discrete, retryable
 * steps without adding a broker; swap for SQS/pg-boss behind the same four calls.
 */

function enqueue(db, type, payload = {}, { runAfter = now() } = {}) {
  const jobId = id('job');
  run(db, `INSERT INTO jobs (id, type, payload_json, state, attempts, run_after, created_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    jobId, type, JSON.stringify(payload), runAfter, now());
  return jobId;
}

function claim(db) {
  const job = get(db, `SELECT * FROM jobs WHERE state = 'pending' AND run_after <= ? ORDER BY run_after LIMIT 1`, now());
  if (!job) return null;
  run(db, `UPDATE jobs SET state = 'running', attempts = attempts + 1 WHERE id = ?`, job.id);
  return { ...job, payload: json(job.payload_json) };
}

const complete = (db, jobId) => run(db, `UPDATE jobs SET state = 'done' WHERE id = ?`, jobId);

const BASE_BACKOFF_MS = 30000;

/**
 * Marks a job failed, with exponential backoff before the next attempt.
 *
 * The backoff is what makes retries meaningful: without pushing `run_after` into the future,
 * the same drain loop re-claims the job immediately and burns all three attempts in one pass,
 * which is exactly when a transient error has had no time to clear.
 *
 * `permanent` skips retries entirely — a job whose type has no handler will not succeed later.
 */
function fail(db, jobId, error, { maxAttempts = 3, permanent = false, baseBackoffMs = BASE_BACKOFF_MS } = {}) {
  const job = get(db, 'SELECT attempts FROM jobs WHERE id = ?', jobId);
  const exhausted = permanent || !job || job.attempts >= maxAttempts;
  const state = exhausted ? 'failed' : 'pending';
  const runAfter = exhausted
    ? now()
    : new Date(Date.now() + baseBackoffMs * 2 ** (job.attempts - 1)).toISOString();

  run(db, `UPDATE jobs SET state = ?, last_error = ?, run_after = ? WHERE id = ?`,
    state, String((error && error.message) || error), runAfter, jobId);
  return state;
}

/** Runs queued jobs until the queue is empty. `handlers` maps job type -> async fn. */
async function drain(db, handlers, { limit = 500 } = {}) {
  const results = { done: 0, failed: 0 };
  for (let i = 0; i < limit; i += 1) {
    const job = claim(db);
    if (!job) break;
    const handler = handlers[job.type];
    if (!handler) {
      fail(db, job.id, new Error(`no handler for job type ${job.type}`), { permanent: true });
      results.failed += 1;
      continue;
    }
    try {
      await handler(db, job.payload, job);
      complete(db, job.id);
      results.done += 1;
    } catch (err) {
      const state = fail(db, job.id, err);
      log.warn('job failed', { type: job.type, state, error: err.message });
      if (state === 'failed') results.failed += 1;
    }
  }
  return results;
}

const pending = (db) => all(db, `SELECT * FROM jobs WHERE state IN ('pending','running') ORDER BY run_after`);

module.exports = { enqueue, claim, complete, fail, drain, pending };
