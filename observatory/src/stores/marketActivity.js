'use strict';
const { id, now } = require('../core/util');
const { run, all, get } = require('../db');

/**
 * Market Activity Store — neutral watched signals (SERP, platform, competitor, ads, social).
 *
 * Append-only by construction: this module exposes no update or delete. A correction is a new
 * observation, so the trends worker can always see what was believed and when.
 */

function append(db, {
  observedAt = now(), channel, subject, signal, value = null, unit = null,
  sourceId = null, artifactId = null, meta = {},
}) {
  const rowId = id('mkt');
  run(db, `INSERT INTO market_activity (id, observed_at, channel, subject, signal, value, unit, source_id, artifact_id, meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rowId, observedAt, channel, subject, signal, value, unit, sourceId, artifactId, JSON.stringify(meta));
  return rowId;
}

const appendMany = (db, rows) => rows.map((row) => append(db, row));

/** One subject+signal ordered oldest-first: the series the trends worker analyses. */
const series = (db, subject, signal, { since = null, limit = 500 } = {}) =>
  all(db, `SELECT * FROM market_activity
           WHERE subject = ? AND signal = ? AND (? IS NULL OR observed_at >= ?)
           ORDER BY observed_at LIMIT ?`,
    subject, signal, since, since, limit);

const subjects = (db) =>
  all(db, `SELECT subject, signal, COUNT(*) AS observations, MIN(observed_at) AS first_seen, MAX(observed_at) AS last_seen
           FROM market_activity GROUP BY subject, signal ORDER BY last_seen DESC`);

const recent = (db, limit = 50) =>
  all(db, 'SELECT * FROM market_activity ORDER BY observed_at DESC LIMIT ?', limit);

const between = (db, start, end) =>
  all(db, 'SELECT * FROM market_activity WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at', start, end);

const latest = (db, subject, signal) =>
  get(db, 'SELECT * FROM market_activity WHERE subject = ? AND signal = ? ORDER BY observed_at DESC LIMIT 1', subject, signal);

module.exports = { append, appendMany, series, subjects, recent, between, latest };
