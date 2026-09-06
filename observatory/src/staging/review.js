'use strict';
const { id, now } = require('../core/util');
const { all, get, run } = require('../db');
const { logger } = require('../core/log');
const audit = require('../core/audit');
const policy = require('../core/policy');
const domainKb = require('../stores/domainKb');
const annotations = require('../reasoning/annotations');
const { promote, decline } = require('./promote');

const log = logger('review');

/**
 * Human Review gate — critical, accepted, added detail, declined, legacy, superseded.
 *
 * The queue is the hinge of the whole map: everything the workers cannot decide safely lands
 * here with its reasoning attached, and every decision is recorded against the reviewer.
 */

const DECISIONS = ['accepted', 'accepted_with_detail', 'declined', 'critical', 'legacy', 'superseded'];

function enqueue(db, { candidateId = null, kbEntryId = null, reason, severity = 'normal', detail = null, assignedTo = null }) {
  const reviewId = id('rev');
  run(db, `INSERT INTO review_queue (id, candidate_id, kb_entry_id, reason, severity, detail, assigned_to, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    reviewId, candidateId, kbEntryId, reason, severity, detail, assignedTo, now());
  return reviewId;
}

const open = (db, { severity = null, limit = 100 } = {}) =>
  all(db, `SELECT r.*, c.title, c.domain, c.kind, c.trust, c.risk, c.client_id, c.body
           FROM review_queue r LEFT JOIN candidates c ON c.id = r.candidate_id
           WHERE r.state = 'open' AND (? IS NULL OR r.severity = ?)
           ORDER BY CASE r.severity WHEN 'critical' THEN 0 ELSE 1 END, r.created_at
           LIMIT ?`, severity, severity, limit);

const byId = (db, reviewId) =>
  get(db, `SELECT r.*, c.title, c.domain, c.kind, c.trust, c.risk, c.client_id, c.body, c.artifact_id
           FROM review_queue r LEFT JOIN candidates c ON c.id = r.candidate_id WHERE r.id = ?`, reviewId);

/**
 * Applies a reviewer's decision.
 * @param {object} input.principal  must be at least `reviewer`
 * @param {string} input.decision   one of DECISIONS
 * @param {string} [input.detail]   extra content merged into the promoted entry
 * @param {string} [input.supersedesId] KB entry this one replaces (required for `superseded`)
 */
function decide(db, reviewId, { principal, decision, detail = null, rationale = null, supersedesId = null }) {
  policy.assertRole(principal, 'reviewer');
  if (!DECISIONS.includes(decision)) throw new Error(`unknown decision: ${decision}`);

  const item = byId(db, reviewId);
  if (!item) throw new Error(`review item not found: ${reviewId}`);
  if (item.state === 'decided') throw new Error(`review item ${reviewId} is already decided`);

  const actor = principal.id;
  const result = { reviewId, decision };

  switch (decision) {
    case 'accepted':
      Object.assign(result, promote(db, item.candidate_id, { actor, reason: 'accepted in review' }));
      break;

    case 'accepted_with_detail':
      if (!detail) throw new Error('accepted_with_detail requires detail');
      Object.assign(result, promote(db, item.candidate_id, { actor, reason: 'accepted with added detail', detail }));
      break;

    case 'declined':
      Object.assign(result, decline(db, item.candidate_id, { actor, reason: rationale || 'declined in review' }));
      break;

    case 'legacy': {
      // Worth keeping for the record, but not something the reasoning layer should rely on.
      const promoted = promote(db, item.candidate_id, { actor, reason: 'accepted as legacy' });
      if (promoted.kbEntryId) domainKb.setStatus(db, promoted.kbEntryId, 'legacy', { actor, reason: 'marked legacy in review' });
      Object.assign(result, promoted);
      break;
    }

    case 'superseded': {
      const target = supersedesId || item.kb_entry_id;
      if (!target) throw new Error('superseded requires supersedesId (or a review item carrying kb_entry_id)');
      const promoted = promote(db, item.candidate_id, { actor, reason: `supersedes ${target}` });
      if (promoted.kbEntryId) {
        const old = domainKb.byId(db, target);
        run(db, 'UPDATE kb_entries SET supersedes_id = ?, version = ? WHERE id = ?',
          target, (old ? old.version : 0) + 1, promoted.kbEntryId);
        domainKb.setStatus(db, target, 'superseded', { actor, reason: `superseded by ${promoted.kbEntryId}` });
      }
      Object.assign(result, promoted, { supersedes: target });
      break;
    }

    case 'critical':
      // Escalation, not a resolution: the item stays open at critical severity.
      run(db, `UPDATE review_queue SET severity = 'critical', assigned_to = ? WHERE id = ?`, item.assigned_to, reviewId);
      break;
  }

  run(db, `INSERT INTO review_decisions (id, review_id, decision, detail, rationale, actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id('dec'), reviewId, decision, detail, rationale, actor, now());

  // The reviewer's reasoning follows the object it was about, not just the queue item — six
  // months later the question is "why does this entry say that", asked of the entry.
  if (rationale || detail) {
    const note = [rationale, detail && `Added detail: ${detail}`].filter(Boolean).join('\n');
    annotations.add(db, { objectType: 'review', objectId: reviewId, kind: 'rationale', note, actor });
    if (result.kbEntryId) {
      annotations.add(db, {
        objectType: 'kb_entry', objectId: result.kbEntryId, kind: 'rationale',
        note: `${decision}: ${note}`, actor,
      });
    }
  }

  if (decision !== 'critical') {
    run(db, `UPDATE review_queue SET state = 'decided', decided_at = ? WHERE id = ?`, now(), reviewId);
  }

  audit.record(db, {
    objectType: 'review', objectId: reviewId,
    from: 'open', to: decision === 'critical' ? 'escalated' : 'decided',
    actor, reason: rationale || decision,
  });

  log.info('review decided', { reviewId, decision, actor });
  return result;
}

const decisionsFor = (db, reviewId) =>
  all(db, 'SELECT * FROM review_decisions WHERE review_id = ? ORDER BY created_at', reviewId);

const stats = (db) => ({
  open: all(db, `SELECT severity, COUNT(*) AS n FROM review_queue WHERE state = 'open' GROUP BY severity`),
  decisions: all(db, 'SELECT decision, COUNT(*) AS n FROM review_decisions GROUP BY decision'),
});

module.exports = { DECISIONS, enqueue, open, byId, decide, decisionsFor, stats };
