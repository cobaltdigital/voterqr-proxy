'use strict';
const { id, now } = require('../core/util');
const { run, all, get } = require('../db');

/** Trends Schema — detections + sources, watchlist, review actions. */

function record(db, {
  kind, domain = null, subject, summary, score,
  windowStart = null, windowEnd = null, evidence = [], action = 'watch',
}) {
  const detectionId = id('trd');
  run(db, `INSERT INTO trend_detections (id, detected_at, kind, domain, subject, summary, score, window_start, window_end, evidence_json, action, state)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
    detectionId, now(), kind, domain, subject, summary, score, windowStart, windowEnd, JSON.stringify(evidence), action);
  return detectionId;
}

function watch(db, detectionId, subject) {
  const existing = get(db, `SELECT id FROM trend_watchlist WHERE subject = ? AND state = 'active'`, subject);
  if (existing) return existing.id;
  const rowId = id('wtc');
  run(db, `INSERT INTO trend_watchlist (id, detection_id, subject, added_at, state) VALUES (?, ?, ?, ?, 'active')`,
    rowId, detectionId, subject, now());
  run(db, `UPDATE trend_detections SET state = 'watching' WHERE id = ?`, detectionId);
  return rowId;
}

const setState = (db, detectionId, state) =>
  run(db, 'UPDATE trend_detections SET state = ? WHERE id = ?', state, detectionId);

const recent = (db, limit = 25) =>
  all(db, 'SELECT * FROM trend_detections ORDER BY detected_at DESC LIMIT ?', limit);

const byState = (db, state, limit = 50) =>
  all(db, 'SELECT * FROM trend_detections WHERE state = ? ORDER BY score DESC LIMIT ?', state, limit);

const since = (db, timestamp) =>
  all(db, 'SELECT * FROM trend_detections WHERE detected_at >= ? ORDER BY score DESC', timestamp);

const watchlist = (db) =>
  all(db, `SELECT * FROM trend_watchlist WHERE state = 'active' ORDER BY added_at DESC`);

/** Same subject + kind inside the cooldown window: stops a persistent shift re-alerting daily. */
const alreadyDetected = (db, { subject, kind, withinHours = 72 }) => {
  const cutoff = new Date(Date.now() - withinHours * 3600000).toISOString();
  return get(db, `SELECT id FROM trend_detections WHERE subject = ? AND kind = ? AND detected_at >= ?`,
    subject, kind, cutoff);
};

module.exports = { record, watch, setState, recent, byState, since, watchlist, alreadyDetected };
