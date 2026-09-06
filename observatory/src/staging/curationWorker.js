'use strict';
const { id, now, json, fingerprint, similarity, topicalOverlap, tokens } = require('../core/util');
const { all, get, run } = require('../db');
const { logger } = require('../core/log');
const policy = require('../core/policy');
const audit = require('../core/audit');
const routing = require('./routing');
const review = require('./review');
const { promote, UnhandledKindError } = require('./promote');

const log = logger('curation');

/**
 * Curation Worker — dedupe, classify, source trust, risk, route to domain, promotion audit.
 *
 * Reads new staging artifacts and produces candidates. A candidate either auto-promotes
 * (well-sourced, low-risk, confidently routed) or lands in the human review queue with the
 * reason attached. Nothing skips the audit trail either way.
 */

function candidateFromArtifact(db, artifact) {
  const source = get(db, 'SELECT * FROM sources WHERE id = ?', artifact.source_id);
  const payload = json(artifact.payload_json, {});
  const kind = routing.classifyKind(artifact, payload);
  const title = payload.title || payload.subject || artifact.uri || 'untitled';
  const body = payload.text || payload.summary || payload.body ||
    (payload.value != null ? `${payload.subject} ${payload.signal} = ${payload.value}${payload.unit ? ' ' + payload.unit : ''}` : '');

  const routed = payload.domain
    ? { domain: payload.domain, score: 0.6 }
    : routing.routeDomain(`${title} ${body}`);

  const clientId = payload.client_id || source.client_id || null;
  // A meeting note or task is filed by client; not having a marketing domain is not a defect in it.
  const domainRequired = !(policy.DOMAIN_EXEMPT_KINDS.has(kind) && clientId);

  const { trust, reasons: trustReasons } = routing.scoreTrust({ source, artifact, domainScore: routed.score, payload, domainRequired });
  const { risk, reasons: riskReasons } = routing.scoreRisk({ payload, kind, clientId, source });

  return {
    artifact, source, payload, kind, title, body,
    domain: routed.domain, domainScore: routed.score,
    trust, risk, clientId,
    reasons: { trust: trustReasons, risk: riskReasons, routing: routed.scores },
  };
}

/**
 * Two ways to be a near-duplicate:
 *   1. high Jaccard — the same text, reworded slightly. Applies across sources.
 *   2. near-total containment at a comparable length — the same page re-collected after gaining
 *      a sentence. Only applied *within one source*: when a different source restates our content
 *      with extra detail, that is a second opinion worth reviewing, not a re-fetch to discard.
 * The length-ratio guard stops a short claim being swallowed by a long document that merely
 * mentions the same terms.
 */
function isNearDuplicate(a, b, { sameSource = false } = {}) {
  if (similarity(a, b) >= policy.PROMOTION.duplicateSimilarity) return true;
  if (!sameSource) return false;
  const sizeA = new Set(tokens(a)).size;
  const sizeB = new Set(tokens(b)).size;
  if (sizeA < 8 || sizeB < 8) return false;
  const ratio = Math.max(sizeA, sizeB) / Math.min(sizeA, sizeB);
  return ratio <= policy.PROMOTION.duplicateLengthRatio && topicalOverlap(a, b) >= policy.PROMOTION.duplicateContainment;
}

/** Exact fingerprint first (cheap), then near-duplicate by content overlap inside the same domain. */
function findDuplicate(db, { fp, domain, title, body, sourceId }) {
  const exact = get(db, `SELECT id FROM candidates WHERE fingerprint = ? AND state != 'declined' LIMIT 1`, fp);
  if (exact) return { id: exact.id, kind: 'exact' };

  const peers = all(db, `SELECT c.id, c.title, c.body, a.source_id
                         FROM candidates c JOIN staging_artifacts a ON a.id = c.artifact_id
                         WHERE c.domain = ? AND c.state IN ('promoted','in_review','pending')
                         ORDER BY c.created_at DESC LIMIT 400`, domain);
  for (const peer of peers) {
    const sameSource = peer.source_id === sourceId;
    if (isNearDuplicate(`${title} ${body}`, `${peer.title} ${peer.body}`, { sameSource })) {
      return { id: peer.id, kind: 'near' };
    }
  }
  return null;
}

/** Processes every artifact still in `new`. Idempotent: a second pass finds nothing to do. */
function run_(db, { limit = 500, actor = 'curation_worker' } = {}) {
  const artifacts = all(db, `SELECT * FROM staging_artifacts WHERE state = 'new' ORDER BY fetched_at LIMIT ?`, limit);
  const summary = { processed: 0, promoted: 0, queued: 0, duplicates: 0 };

  for (const artifact of artifacts) {
    const c = candidateFromArtifact(db, artifact);
    const fp = fingerprint(c.title, c.body, c.domain);
    const candidateId = id('cand');
    const duplicate = findDuplicate(db, { fp, domain: c.domain, title: c.title, body: c.body, sourceId: artifact.source_id });

    run(db, `INSERT INTO candidates (id, artifact_id, domain, kind, title, body, fingerprint, duplicate_of,
                                     client_id, trust, risk, state, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      candidateId, artifact.id, c.domain, c.kind, c.title, c.body, fp, duplicate ? duplicate.id : null,
      c.clientId, c.trust, c.risk, duplicate ? 'duplicate' : 'pending', now());

    run(db, `UPDATE staging_artifacts SET state = 'curated' WHERE id = ?`, artifact.id);
    summary.processed += 1;

    if (duplicate) {
      audit.record(db, {
        objectType: 'candidate', objectId: candidateId, to: 'duplicate', actor,
        reason: `${duplicate.kind} duplicate of ${duplicate.id}`,
      });
      summary.duplicates += 1;
      continue;
    }

    const decision = policy.routeCandidate({ domain: c.domain, trust: c.trust, risk: c.risk, kind: c.kind, clientId: c.clientId });
    if (decision.state === 'promoted') {
      try {
        promote(db, candidateId, { actor, reason: 'auto-promoted: trust and risk within policy' });
        summary.promoted += 1;
        continue;
      } catch (err) {
        // No store claims this kind. Queue it rather than marking it promoted into nothing.
        if (!(err instanceof UnhandledKindError)) throw err;
        log.warn('candidate has no destination store', { candidateId, kind: c.kind });
        decision.reason = 'unhandled_kind';
        decision.severity = 'normal';
      }
    }
    {
      run(db, `UPDATE candidates SET state = 'in_review' WHERE id = ?`, candidateId);
      review.enqueue(db, {
        candidateId,
        reason: decision.reason,
        severity: decision.severity,
        detail: [
          `trust ${c.trust.toFixed(2)} (${c.reasons.trust.join('; ')})`,
          `risk ${c.risk.toFixed(2)} (${c.reasons.risk.join('; ') || 'no risk rules matched'})`,
          `routed to ${c.domain}`,
        ].join('\n'),
      });
      audit.record(db, {
        objectType: 'candidate', objectId: candidateId, from: 'pending', to: 'in_review', actor,
        reason: decision.reason,
      });
      summary.queued += 1;
    }
  }

  if (summary.processed) log.info('curation pass complete', summary);
  return summary;
}

module.exports = { run: run_, candidateFromArtifact, findDuplicate };
