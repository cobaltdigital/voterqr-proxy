'use strict';
const { id, now } = require('../core/util');
const { run, all, get } = require('../db');
const audit = require('../core/audit');
const policy = require('../core/policy');
const trendsStore = require('../stores/trendsStore');
const annotations = require('./annotations');

/**
 * Workflows — Tallyfy drafts, recommended actions, site-change records.
 *
 * Everything produced here is a draft. Dispatching to an external system requires an explicit
 * human approval step, so an automated recommendation can never become an executed change on its own.
 */

const KINDS = ['tallyfy_draft', 'recommended_action', 'site_change'];

/**
 * Creates a draft. When `refType`/`refId` name what produced it, the draft is idempotent:
 * a second pass over the same detection returns the existing draft instead of a duplicate.
 */
function draft(db, { kind, title, body, clientId = null, runId = null, refType = null, refId = null, actor = 'workflow_worker' }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown workflow kind: ${kind}`);

  if (refId) {
    const existing = get(db, 'SELECT id FROM workflow_drafts WHERE kind = ? AND ref_type = ? AND ref_id = ?', kind, refType, refId);
    if (existing) return existing.id;
  }

  const draftId = id('wfd');
  run(db, `INSERT INTO workflow_drafts (id, kind, title, body, client_id, status, run_id, ref_type, ref_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    draftId, kind, title, body, clientId, runId, refType, refId, now());
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
      refType: 'claim',
      refId: point.claim_id,
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

/**
 * Watched trends become site-change records: the "what we changed and when" trail for a site.
 * Keyed on the detection, so running this every scheduled pass does not duplicate drafts.
 */
function fromTrends(db, { limit = 5, domains = ['web_design', 'seo'] } = {}) {
  const drafts = [];
  for (const detection of trendsStore.byState(db, 'watching', limit)) {
    if (!domains.includes(detection.domain)) continue;
    drafts.push(draft(db, {
      kind: 'site_change',
      refType: 'trend_detection',
      refId: detection.id,
      title: `Proposed site change from trend: ${detection.subject}`.slice(0, 160),
      body: `${detection.summary}\n\nDetection ${detection.id} (${detection.kind}, score ${detection.score.toFixed(2)}).\n` +
            'Record the change made, the date, and the metric it is expected to move.',
    }));
  }
  return drafts;
}

/** Approval is recorded twice on purpose: the audit trail proves it happened, the annotation
 *  ledger carries the reviewer's reasoning where the next person will actually read it. */
function decide(db, draftId, status, { principal, note = null }) {
  policy.assertRole(principal, 'reviewer');
  const draftRow = get(db, 'SELECT status FROM workflow_drafts WHERE id = ?', draftId);
  if (!draftRow) throw new Error(`workflow draft not found: ${draftId}`);

  run(db, 'UPDATE workflow_drafts SET status = ? WHERE id = ?', status, draftId);
  audit.record(db, {
    objectType: 'workflow_draft', objectId: draftId,
    from: draftRow.status, to: status, actor: principal.id, reason: note,
  });
  annotations.add(db, {
    objectType: 'workflow_draft', objectId: draftId, kind: 'approval',
    note: `${status}${note ? `: ${note}` : ''}`, actor: principal.id,
  });
  return draftId;
}

const approve = (db, draftId, opts) => decide(db, draftId, 'approved', opts);
const reject = (db, draftId, opts) => decide(db, draftId, 'rejected', opts);

const list = (db, { status = null, limit = 50 } = {}) =>
  all(db, `SELECT * FROM workflow_drafts WHERE (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ?`,
    status, status, limit);

module.exports = { KINDS, draft, fromReasoning, fromTrends, approve, reject, decide, list };
