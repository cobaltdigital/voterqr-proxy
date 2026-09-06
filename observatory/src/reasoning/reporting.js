'use strict';
const { id, now } = require('../core/util');
const { run, all } = require('../db');
const policy = require('../core/policy');
const marketActivity = require('../stores/marketActivity');
const trendsStore = require('../stores/trendsStore');
const evidence = require('../stores/evidenceLedger');
const inquiryStore = require('../stores/inquiryStore');

/**
 * Reporting — weekly market brief, source-backed claims, report-safe views.
 *
 * Every claim printed in a brief carries its sources. A brief generated with `safe: true`
 * additionally runs client names through the report-safe filter, so the same generator produces
 * both the internal and the shareable version without a second code path to keep in sync.
 */

const iso = (d) => d.toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

function weeklyBrief(db, { periodStart = iso(daysAgo(7)), periodEnd = now(), safe = false, actor = 'reporting' } = {}) {
  const clients = safe ? all(db, 'SELECT id, name, tier FROM clients') : [];
  const scrub = (text) => (safe ? policy.reportSafe(text, clients) : text);

  const observations = marketActivity.between(db, periodStart, periodEnd);
  const detections = trendsStore.since(db, periodStart);
  const claims = evidence.recent(db, 200).filter((c) => c.asserted_at >= periodStart);
  const openInquiries = inquiryStore.open(db, { limit: 10 });

  const bySubject = new Map();
  for (const row of observations) {
    const key = `${row.subject} · ${row.signal}`;
    const bucket = bySubject.get(key) || { first: row, last: row, n: 0, unit: row.unit };
    bucket.last = row;
    bucket.n += 1;
    bySubject.set(key, bucket);
  }

  const lines = [
    `# Weekly Market Brief`,
    `_${periodStart.slice(0, 10)} → ${periodEnd.slice(0, 10)}${safe ? ' · report-safe view' : ''}_`,
    '',
    `## Watched signals (${bySubject.size})`,
  ];

  if (!bySubject.size) lines.push('_No market activity recorded in this window._');
  for (const [key, bucket] of bySubject) {
    const from = bucket.first.value;
    const to = bucket.last.value;
    const delta = from != null && to != null && from !== 0 ? ((to - from) / Math.abs(from)) * 100 : null;
    const arrow = delta == null ? '·' : delta > 1 ? '▲' : delta < -1 ? '▼' : '=';
    lines.push(`- **${scrub(key)}** ${arrow} ${from ?? '—'} → ${to ?? '—'}${bucket.unit ? ' ' + bucket.unit : ''}` +
      `${delta == null ? '' : ` (${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%)`} · ${bucket.n} observations`);
  }

  lines.push('', `## Detected trends (${detections.length})`);
  if (!detections.length) lines.push('_Nothing crossed the detection thresholds._');
  for (const d of detections.slice(0, 10)) {
    lines.push(`- **[${d.kind}]** ${scrub(d.summary)} · action: ${d.action} · state: ${d.state}`);
  }

  lines.push('', `## New source-backed claims (${claims.length})`);
  if (!claims.length) lines.push('_No claims were added to the ledger this week._');
  for (const claim of claims.slice(0, 15)) {
    const sources = claim.citations.map((c) => c.source_name || c.source_id).join(', ');
    lines.push(`- ${scrub(claim.statement)}`);
    lines.push(`  - confidence ${claim.confidence.toFixed(2)} · evidence ${claim.freshness_days}d old · sources: ${sources || 'none'}`);
  }

  if (openInquiries.length) {
    lines.push('', `## Open questions (${openInquiries.length})`);
    for (const q of openInquiries) lines.push(`- [${q.origin}] ${scrub(q.question)} _(${q.status})_`);
  }

  const stats = evidence.stats(db);
  lines.push('', '---',
    `Evidence ledger: ${stats.claims} claims / ${stats.citations} citations` +
    `${stats.uncited ? ` · ⚠ ${stats.uncited} uncited` : ' · all claims cited'}`);

  const body = lines.join('\n');
  const reportId = id('rpt');
  run(db, `INSERT INTO reports (id, kind, period_start, period_end, body_md, safe, created_at)
           VALUES (?, 'weekly_market_brief', ?, ?, ?, ?, ?)`,
    reportId, periodStart, periodEnd, body, safe ? 1 : 0, now());

  return { reportId, body, safe, periodStart, periodEnd, actor };
}

const list = (db, limit = 20) =>
  all(db, 'SELECT id, kind, period_start, period_end, safe, created_at FROM reports ORDER BY created_at DESC LIMIT ?', limit);

const byId = (db, reportId) => all(db, 'SELECT * FROM reports WHERE id = ?', reportId)[0] || null;

module.exports = { weeklyBrief, list, byId };
