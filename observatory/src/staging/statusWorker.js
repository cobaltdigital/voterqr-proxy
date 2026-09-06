'use strict';
const { topicalOverlap, daysBetween, now } = require('../core/util');
const { all, get } = require('../db');
const { logger } = require('../core/log');
const policy = require('../core/policy');
const review = require('./review');
const evidence = require('../stores/evidenceLedger');

const log = logger('status');

/**
 * Status Worker — compares the KB against the evidence ledger, finds entries that contradict or
 * supersede each other, and suggests human review. It never changes an entry's status itself:
 * flipping a belief to `superseded` is a decision a person makes in the review gate.
 */

const NEGATION = /\b(not|never|no longer|avoid|stop|deprecated|don't|do not|should not|discontinued)\b/i;

/** Numbers with their units, so "LCP under 2.5s" and "LCP under 4s" can be compared. */
function numbers(text) {
  const out = [];
  const re = /(-?\d+(?:\.\d+)?)\s*(%|ms|s|sec|seconds|px|x|cents|usd|\$)?/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const value = Number(m[1]);
    if (Number.isNaN(value)) continue;
    out.push({ value, unit: (m[2] || '').toLowerCase() });
  }
  return out;
}

/**
 * Same claim shape, materially different number → the two entries cannot both be current.
 * Only unit-bearing numbers are compared: bare integers in prose ("two to three weeks",
 * a step number, a year) collide constantly and produce contradictions that are not real.
 */
function numericConflict(a, b, tolerance = 0.15) {
  const na = numbers(`${a.title} ${a.body}`).filter((n) => n.unit);
  const nb = numbers(`${b.title} ${b.body}`).filter((n) => n.unit);
  if (!na.length || !nb.length) return null;

  for (const x of na) {
    for (const y of nb) {
      if (x.unit !== y.unit) continue;
      const scale = Math.max(Math.abs(x.value), Math.abs(y.value), 1);
      const delta = Math.abs(x.value - y.value) / scale;
      if (delta > tolerance) return { a: x, b: y, delta: Math.round(delta * 100) / 100 };
    }
  }
  return null;
}

const negationConflict = (a, b) =>
  NEGATION.test(`${a.title} ${a.body}`) !== NEGATION.test(`${b.title} ${b.body}`);

function alreadyFlagged(db, entryId, otherId, reason) {
  return get(db, `SELECT id FROM review_queue
                  WHERE state = 'open' AND reason = ? AND kb_entry_id = ? AND detail LIKE ?`,
    reason, entryId, `%${otherId}%`);
}

function run_(db, { staleDays = 180, limit = 400 } = {}) {
  const entries = all(db, `SELECT * FROM kb_entries WHERE status = 'current' ORDER BY updated_at DESC LIMIT ?`, limit);
  const summary = { compared: 0, contradictions: 0, supersessions: 0, staleClaims: 0 };
  const seen = new Set();

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (a.domain !== b.domain || a.client_scope !== b.client_scope) continue;

      const overlap = topicalOverlap(`${a.title} ${a.body}`, `${b.title} ${b.body}`);
      if (overlap < policy.PROMOTION.contradictionSimilarity) continue;
      summary.compared += 1;

      const pairKey = [a.id, b.id].sort().join('|');
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      // Newer entry wins the "candidate replacement" role; older one is the flagged object.
      const [older, newer] = new Date(a.created_at) <= new Date(b.created_at) ? [a, b] : [b, a];
      const conflict = numericConflict(older, newer);
      const negated = negationConflict(older, newer);

      if (conflict || negated) {
        if (alreadyFlagged(db, older.id, newer.id, 'contradiction')) continue;
        review.enqueue(db, {
          kbEntryId: older.id,
          reason: 'contradiction',
          severity: 'critical',
          detail: [
            `"${older.title}" (${older.id}) conflicts with "${newer.title}" (${newer.id})`,
            `overlap ${overlap.toFixed(2)}`,
            conflict ? `numeric conflict: ${conflict.a.value}${conflict.a.unit} vs ${conflict.b.value}${conflict.b.unit} (${Math.round(conflict.delta * 100)}% apart)` : null,
            negated ? 'one entry negates the other' : null,
            'Resolve by superseding one entry or declining the newer claim.',
          ].filter(Boolean).join('\n'),
        });
        summary.contradictions += 1;
        continue;
      }

      // No conflict, but the newer entry restates the older one with fresher evidence.
      const olderFresh = freshestEvidence(db, older.id);
      const newerFresh = freshestEvidence(db, newer.id);
      if (olderFresh && newerFresh && daysBetween(olderFresh, newerFresh) > 30 && overlap >= policy.PROMOTION.supersessionSimilarity) {
        if (alreadyFlagged(db, older.id, newer.id, 'supersession')) continue;
        review.enqueue(db, {
          kbEntryId: older.id,
          reason: 'supersession',
          severity: 'normal',
          detail: [
            `"${newer.title}" (${newer.id}) appears to supersede "${older.title}" (${older.id})`,
            `overlap ${overlap.toFixed(2)}; newer evidence is ${Math.round(daysBetween(olderFresh, newerFresh))} days fresher`,
          ].join('\n'),
        });
        summary.supersessions += 1;
      }
    }
  }

  // Entries whose supporting evidence has gone stale: still current, but no longer well-supported.
  for (const claim of evidence.stale(db, { olderThanDays: staleDays, limit: 25 })) {
    if (!claim.kb_entry_id) continue;
    if (alreadyFlagged(db, claim.kb_entry_id, claim.id, 'stale_evidence')) continue;
    review.enqueue(db, {
      kbEntryId: claim.kb_entry_id,
      reason: 'stale_evidence',
      severity: 'normal',
      detail: `Claim ${claim.id} ("${claim.statement.slice(0, 120)}") rests on evidence ${claim.freshness_days} days old. Re-verify or mark legacy.`,
    });
    summary.staleClaims += 1;
  }

  log.info('status pass complete', summary);
  return summary;
}

function freshestEvidence(db, kbEntryId) {
  const row = get(db, 'SELECT MAX(freshness_at) AS freshest FROM claims WHERE kb_entry_id = ?', kbEntryId);
  return row && row.freshest ? row.freshest : null;
}

module.exports = { run: run_, numbers, numericConflict, negationConflict, freshestEvidence, NEGATION };
