'use strict';
const { id, now } = require('../core/util');
const { run, all, get } = require('../db');
const policy = require('../core/policy');
const domainKb = require('../stores/domainKb');
const evidence = require('../stores/evidenceLedger');
const clientCorpus = require('../stores/clientCorpus');

/**
 * Strategy + Sales — opportunity briefs, aggregate proof points, public-safe candidates.
 *
 * Proof points are aggregated from cited claims only, and anything marked public-safe has been
 * through the report-safe filter and carries no client-scoped material. A brief that cannot be
 * made public-safe says so rather than being published anyway.
 */

/** Cited, confident, reasonably fresh claims — the only material allowed to become a proof point. */
function proofPoints(db, { domain = null, minConfidence = 0.6, maxAgeDays = 365, limit = 10 } = {}) {
  return evidence.recent(db, 300)
    .filter((claim) => (!domain || claim.domain === domain))
    .filter((claim) => claim.citations.length > 0)
    .filter((claim) => evidence.decayedConfidence(claim) >= minConfidence)
    .filter((claim) => claim.freshness_days <= maxAgeDays)
    .slice(0, limit)
    .map((claim) => ({
      statement: claim.statement,
      domain: claim.domain,
      confidence: Math.round(evidence.decayedConfidence(claim) * 100) / 100,
      freshness_days: claim.freshness_days,
      sources: claim.citations.map((c) => c.source_name || c.source_id),
      client_scoped: Boolean(get(db, `SELECT 1 AS x FROM kb_entries WHERE id = ? AND client_scope != 'shared'`, claim.kb_entry_id)),
    }));
}

function opportunityBrief(db, { principal, clientId = null, domain = null, title = null, publicSafe = false }) {
  if (clientId) policy.assertClientAccess(principal, clientId);

  const points = proofPoints(db, { domain });
  const usable = publicSafe ? points.filter((p) => !p.client_scoped) : points;
  const entries = domainKb.current(db, { domain, clientScope: clientId, limit: 8 });
  const context = clientId ? clientCorpus.forClient(db, principal, clientId, { limit: 5 }) : [];
  const clients = all(db, 'SELECT id, name, tier FROM clients');

  const scrub = (text) => (publicSafe ? policy.reportSafe(text, clients) : text);
  const heading = title || `Opportunity brief${domain ? ` — ${domain.replace('_', ' ')}` : ''}`;

  const lines = [
    `# ${scrub(heading)}`,
    publicSafe ? '_Public-safe: client identity removed, client-scoped claims excluded._' : '_Internal: contains client-scoped material._',
    '',
    `## Proof points (${usable.length})`,
  ];
  if (!usable.length) {
    lines.push(publicSafe
      ? '_No claim currently qualifies as public-safe. Publish nothing until evidence is broadened beyond client-scoped sources._'
      : '_No claim meets the confidence and freshness bar yet._');
  }
  for (const point of usable) {
    lines.push(`- ${scrub(point.statement)}`);
    lines.push(`  - confidence ${point.confidence} · ${point.freshness_days}d old · sources: ${point.sources.join(', ')}`);
  }

  lines.push('', `## Relevant playbook (${entries.length})`);
  for (const entry of entries) lines.push(`- [${entry.type}] ${scrub(entry.title)}`);

  if (context.length) {
    lines.push('', `## Client context (${context.length})`);
    for (const row of context) lines.push(`- [${row.kind}] ${scrub(row.title)}`);
  }

  const body = lines.join('\n');
  const briefId = id('opb');
  run(db, `INSERT INTO opportunity_briefs (id, client_id, title, body, proof_points_json, public_safe, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
    briefId, clientId, heading, body, JSON.stringify(usable), publicSafe ? 1 : 0, now());

  return { briefId, title: heading, body, proofPoints: usable, publicSafe };
}

const list = (db, limit = 20) =>
  all(db, 'SELECT id, client_id, title, public_safe, created_at FROM opportunity_briefs ORDER BY created_at DESC LIMIT ?', limit);

module.exports = { proofPoints, opportunityBrief, list };
