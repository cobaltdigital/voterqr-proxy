'use strict';
const { id, now, coverage } = require('../core/util');
const { run, all, get } = require('../db');
const policy = require('../core/policy');

/**
 * Client Corpus Index — stored by client_id: sales, ICP, docs, tasks, meetings, Tallyfy, email.
 *
 * Holds source refs and snippets, not full raw bodies. Every read takes a principal and passes
 * through the access policy, so client isolation is enforced at the store rather than remembered
 * by each caller.
 */

const SNIPPET_MAX = 600;

function index(db, {
  clientId, kind, title, snippet, sourceRef, metadata = {}, access = {},
}) {
  if (!clientId) throw new Error('client corpus rows require a client_id');
  if (!sourceRef) throw new Error('client corpus rows require a source_ref back to staging');
  const rowId = id('cc');
  run(db, `INSERT INTO client_corpus (id, client_id, kind, title, snippet, source_ref, metadata_json, access_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rowId, clientId, kind, title, String(snippet || '').slice(0, SNIPPET_MAX), sourceRef,
    JSON.stringify(metadata), JSON.stringify(access), now());
  return rowId;
}

/** All rows a principal may see for a client. Throws before touching the database on a scope miss. */
function forClient(db, principal, clientId, { kind = null, limit = 100 } = {}) {
  policy.assertClientAccess(principal, clientId);
  const rows = all(db, `SELECT * FROM client_corpus WHERE client_id = ? AND (? IS NULL OR kind = ?)
                        ORDER BY created_at DESC LIMIT ?`, clientId, kind, kind, limit);
  return policy.visibleRows(principal, rows);
}

/** Search restricted to the principal's client scope — never a cross-client leak by omission. */
function search(db, principal, query, { clientId = null, limit = 10, minScore = 0.25 } = {}) {
  if (clientId) policy.assertClientAccess(principal, clientId);
  const rows = all(db, `SELECT * FROM client_corpus WHERE (? IS NULL OR client_id = ?) ORDER BY created_at DESC LIMIT 2000`,
    clientId, clientId);
  return policy.visibleRows(principal, rows)
    .map((row) => ({ ...row, score: coverage(query, `${row.title} ${row.snippet}`) }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const byId = (db, principal, rowId) => {
  const row = get(db, 'SELECT * FROM client_corpus WHERE id = ?', rowId);
  if (!row) return null;
  policy.assertClientAccess(principal, row.client_id);
  return policy.visibleRows(principal, [row])[0] || null;
};

const stats = (db) =>
  all(db, `SELECT c.id AS client_id, c.name, COUNT(cc.id) AS records
           FROM clients c LEFT JOIN client_corpus cc ON cc.client_id = c.id
           GROUP BY c.id, c.name ORDER BY records DESC`);

module.exports = { index, forClient, search, byId, stats, SNIPPET_MAX };
