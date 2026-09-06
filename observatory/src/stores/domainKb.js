'use strict';
const { id, now, coverage, topicalOverlap } = require('../core/util');
const { run, all, get } = require('../db');
const audit = require('../core/audit');

/**
 * Domain KB — SEO, Paid Ads, Social, Local Business, AI, Web Design.
 * SOPs, experiments and facts shared across clients, each carrying current/legacy/superseded status.
 *
 * Entries are never edited in place. A change writes a new version and supersedes the old one, so
 * the reasoning layer can always answer "what did we believe, and when did that change".
 */

function create(db, {
  domain, type = 'fact', title, body, clientScope = 'shared',
  confidence = 0.5, candidateId = null, status = 'current', actor = 'curation_worker',
}) {
  const entryId = id('kb');
  run(db, `INSERT INTO kb_entries (id, domain, type, title, body, status, version, client_scope, confidence, candidate_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    entryId, domain, type, title, body, status, clientScope, confidence, candidateId, now(), now());
  audit.record(db, { objectType: 'kb_entry', objectId: entryId, to: status, actor, reason: 'created' });
  return entryId;
}

/** Replaces an entry with a new version. The old row stays, flipped to `superseded`. */
function supersede(db, oldId, { title, body, confidence, actor = 'status_worker', reason = 'superseded by newer evidence' }) {
  const old = get(db, 'SELECT * FROM kb_entries WHERE id = ?', oldId);
  if (!old) throw new Error(`kb entry not found: ${oldId}`);

  const newId = id('kb');
  run(db, `INSERT INTO kb_entries (id, domain, type, title, body, status, version, supersedes_id, client_scope, confidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?)`,
    newId, old.domain, old.type, title ?? old.title, body ?? old.body,
    old.version + 1, oldId, old.client_scope, confidence ?? old.confidence, now(), now());

  run(db, `UPDATE kb_entries SET status = 'superseded', updated_at = ? WHERE id = ?`, now(), oldId);
  audit.record(db, { objectType: 'kb_entry', objectId: oldId, from: old.status, to: 'superseded', actor, reason });
  audit.record(db, { objectType: 'kb_entry', objectId: newId, to: 'current', actor, reason: `supersedes ${oldId}` });
  return newId;
}

function setStatus(db, entryId, status, { actor = 'human', reason = null } = {}) {
  const entry = get(db, 'SELECT status FROM kb_entries WHERE id = ?', entryId);
  if (!entry) throw new Error(`kb entry not found: ${entryId}`);
  run(db, 'UPDATE kb_entries SET status = ?, updated_at = ? WHERE id = ?', status, now(), entryId);
  audit.record(db, { objectType: 'kb_entry', objectId: entryId, from: entry.status, to: status, actor, reason });
  return entryId;
}

const byId = (db, entryId) => get(db, 'SELECT * FROM kb_entries WHERE id = ?', entryId);

const current = (db, { domain = null, type = null, clientScope = null, limit = 100 } = {}) =>
  all(db, `SELECT * FROM kb_entries
           WHERE status = 'current'
             AND (? IS NULL OR domain = ?)
             AND (? IS NULL OR type = ?)
             AND (? IS NULL OR client_scope = ? OR client_scope = 'shared')
           ORDER BY updated_at DESC LIMIT ?`,
    domain, domain, type, type, clientScope, clientScope, limit);

/**
 * Retrieval by query coverage: how many of the question's terms the entry actually covers.
 * Good enough to rank a few thousand entries; swap in FTS5 or vectors behind this signature.
 */
function search(db, query, { domain = null, clientScope = null, limit = 10, minScore = 0.3 } = {}) {
  return current(db, { domain, clientScope, limit: 1000 })
    .map((entry) => ({ ...entry, score: coverage(query, `${entry.title} ${entry.body}`) }))
    .filter((entry) => entry.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Entries covering the same ground as `text` — symmetric, unlike search. */
const similarEntries = (db, text, { domain = null, threshold = 0.3, excludeId = null } = {}) =>
  current(db, { domain, limit: 1000 })
    .filter((entry) => entry.id !== excludeId)
    .map((entry) => ({ ...entry, score: topicalOverlap(text, `${entry.title} ${entry.body}`) }))
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score);

const stats = (db) =>
  all(db, `SELECT domain, status, COUNT(*) AS entries FROM kb_entries GROUP BY domain, status ORDER BY domain`);

module.exports = { create, supersede, setStatus, byId, current, search, similarEntries, stats };
