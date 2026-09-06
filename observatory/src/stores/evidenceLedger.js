'use strict';
const { id, now, daysBetween, clamp } = require('../core/util');
const { run, all, get } = require('../db');

/**
 * Evidence Ledger — source chains, claims + citations, confidence + freshness.
 *
 * The rule the rest of the system leans on: a claim cannot exist without at least one citation.
 * `assert` rejects an uncited claim outright, which is what lets the reasoning layer treat any
 * uncited statement as a defect rather than as an opinion.
 */

function assert(db, { statement, kbEntryId = null, domain = null, confidence = 0.5, citations = [] }) {
  if (!citations.length) {
    throw new Error(`refusing to record an uncited claim: "${String(statement).slice(0, 80)}"`);
  }
  const claimId = id('clm');
  const freshest = citations
    .map((c) => c.observedAt || now())
    .sort()
    .at(-1);

  run(db, `INSERT INTO claims (id, statement, kb_entry_id, domain, confidence, asserted_at, freshness_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    claimId, statement, kbEntryId, domain, confidence, now(), freshest);

  for (const citation of citations) {
    run(db, `INSERT INTO citations (id, claim_id, artifact_id, source_id, locator, quote, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id('cit'), claimId, citation.artifactId || null, citation.sourceId,
      citation.locator || null, citation.quote ? String(citation.quote).slice(0, 500) : null, now());
  }
  return claimId;
}

const citationsFor = (db, claimId) =>
  all(db, `SELECT ci.*, s.name AS source_name, s.kind AS source_kind, s.trust AS source_trust,
                  a.uri AS artifact_uri, a.fetched_at
           FROM citations ci
           LEFT JOIN sources s ON s.id = ci.source_id
           LEFT JOIN staging_artifacts a ON a.id = ci.artifact_id
           WHERE ci.claim_id = ?`, claimId);

/** A claim with its full source chain attached — what "human-checkable output" means here. */
function chain(db, claimId) {
  const claim = get(db, 'SELECT * FROM claims WHERE id = ?', claimId);
  if (!claim) return null;
  return { ...claim, freshness_days: Math.round(daysBetween(claim.freshness_at, now())), citations: citationsFor(db, claimId) };
}

const forEntry = (db, kbEntryId) =>
  all(db, 'SELECT * FROM claims WHERE kb_entry_id = ? ORDER BY asserted_at DESC', kbEntryId)
    .map((claim) => chain(db, claim.id));

/**
 * Confidence decayed by evidence age. A claim sourced 400 days ago is not as good as it was,
 * and reports should say so rather than quietly presenting it at full strength.
 */
function decayedConfidence(claim, { halfLifeDays = 180 } = {}) {
  const age = daysBetween(claim.freshness_at, now());
  return clamp(claim.confidence * Math.pow(0.5, age / halfLifeDays));
}

const stale = (db, { olderThanDays = 180, limit = 50 } = {}) =>
  all(db, 'SELECT * FROM claims ORDER BY freshness_at LIMIT 2000')
    .filter((claim) => daysBetween(claim.freshness_at, now()) > olderThanDays)
    .slice(0, limit)
    .map((claim) => ({ ...claim, freshness_days: Math.round(daysBetween(claim.freshness_at, now())) }));

const recent = (db, limit = 25) =>
  all(db, 'SELECT * FROM claims ORDER BY asserted_at DESC LIMIT ?', limit).map((c) => chain(db, c.id));

const stats = (db) => ({
  claims: all(db, 'SELECT COUNT(*) AS n FROM claims')[0].n,
  citations: all(db, 'SELECT COUNT(*) AS n FROM citations')[0].n,
  uncited: all(db, 'SELECT COUNT(*) AS n FROM claims c WHERE NOT EXISTS (SELECT 1 FROM citations ci WHERE ci.claim_id = c.id)')[0].n,
});

module.exports = { assert, chain, citationsFor, forEntry, decayedConfidence, stale, recent, stats };
