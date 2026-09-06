'use strict';
const { id, now } = require('../core/util');
const { run, all, get } = require('../db');
const audit = require('../core/audit');
const policy = require('../core/policy');
const trendsStore = require('../stores/trendsStore');

/**
 * Workflows — Tallyfy drafts, recommended actions, site-change records.
 *
 * Everything produced here is a draft. Dispatching to an external system requires an explicit
 * human approval step, so an automated recommendation can never become an executed change on its own.
 */

const KINDS = ['tallyfy_draft', 'recommended_action', 'site_change'];

function draft(db, { kind, title, body, clientId = null, runId = null, actor = 'workflow_worker' }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown workflow kind: ${kind}`);
  const draftId = id('wfd');
  run(db, `INSERT INTO workflow_drafts (id, kind, title, body, client_id, status, run_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
    draftId, kind, title, body, clientId, runId, now());
  audit.record(db, { objectType: 'workflow_draft', objectId: draftId, to: 'draft', actor, reason: kind });
  return draftId;
}

/** Turns a reasoning result into concrete draft actions, each pointing back at its evidence. */
function fromReasoning(db, result, { clientId = null } = {}) {
  const drafts = [];
  for (const point of result.points.slice(0, 3)) {
    const citations = point.citations.map((c) => `- ${c.source_name || c.source_id}: ${c.locator || ''}`).join('\n');
    drafts.push(draft(db, {
      kind: 'recommended_action',
      title: `Act on: ${point.statement}`.slice(0, 160),
      body: [
        point.detail || point.statement,
        '',
        `Confidence ${point.confidence} (evidence ${point.freshness_days} days old), domain ${point.domain}.`,
        'Evidence:',
        citations,
        '',
        `From reasoning run ${result.runId} — "${result.question}"`,
      ].join('\n'),
      clientId,
      runId: result.runId,
    }));
  }
  if (result.unsupported.length) {
    drafts.push(draft(db, {
      kind: 'tallyfy_draft',
      title: `Verify ${result.unsupported.length} unsupported statement(s) before client delivery`,
      body: result.unsupported.map((u) => `- ${u.statement} (${u.reason})`).join('\n'),
      clientId,
      runId: result.runId,
    }));
  }
  return drafts;
}

/** Watched trends become site-change records: the "what we changed and when" trail for a site. */
function fromTrends(db, { limit = 5 } = {}) {
  const drafts = [];
  for (const detection of trendsStore.byState(db, 'watching', limit)) {
    if (detection.domain !== 'web_design' && detection.domain !== 'seo') continue;
    drafts.push(draft(db, {
      kind: 'site_change',
      title: `Proposed site change from trend: ${detection.subject}`.slice(0, 160),
      body: `${detection.summary}\n\nDetection ${detection.id} (${detection.kind}, score ${detection.score.toFixed(2)}).\n` +
            'Record the change made, the date, and the metric it is expected to move.',
    }));
  }
  return drafts;
}

function approve(db, draftId, { principal, note = null }) {
  policy.assertRole(principal, 'reviewer');
  const draftRow = get(db, 'SELECT status FROM workflow_drafts WHERE id = ?', draftId);
  if (!draftRow) throw new Error(`workflow draft not found: ${draftId}`);
  run(db, `UPDATE workflow_drafts SET status = 'approved' WHERE id = ?`, draftId);
  audit.record(db, {
    objectType: 'workflow_draft', objectId: draftId,
    from: draftRow.status, to: 'approved', actor: principal.id, reason: note,
  });
  return draftId;
}

function reject(db, draftId, { principal, note = null }) {
  policy.assertRole(principal, 'reviewer');
  run(db, `UPDATE workflow_drafts SET status = 'rejected' WHERE id = ?`, draftId);
  audit.record(db, { objectType: 'workflow_draft', objectId: draftId, to: 'rejected', actor: principal.id, reason: note });
  return draftId;
}

const list = (db, { status = null, limit = 50 } = {}) =>
  all(db, `SELECT * FROM workflow_drafts WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ?`,
    status, status, limit);

module.exports = { KINDS, draft, fromReasoning, fromTrends, approve, reject, list };
