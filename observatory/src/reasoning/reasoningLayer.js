'use strict';
const { id, now, coverage } = require('../core/util');
const { run, all } = require('../db');
const policy = require('../core/policy');
const domainKb = require('../stores/domainKb');
const clientCorpus = require('../stores/clientCorpus');
const evidence = require('../stores/evidenceLedger');
const trendsStore = require('../stores/trendsStore');
const inquiryStore = require('../stores/inquiryStore');
const { routeDomain } = require('../staging/routing');

/**
 * Reasoning Layer — joins domain KB, client corpus, evidence and policy into human-checkable output.
 *
 * The contract that makes the output checkable: every point carries its citations, and any point
 * that cannot produce one is reported in `unsupported` instead of being presented as an answer.
 * The caller can render the answer knowing nothing uncited slipped into it.
 */

function ask(db, { question, principal, clientId = null, domain = null, limit = 6 }) {
  if (!question) throw new Error('question is required');
  if (clientId) policy.assertClientAccess(principal, clientId);

  const routed = domain || routeDomain(question).domain;
  const searchDomain = routed === 'unrouted' ? null : routed;

  const entries = domainKb.search(db, question, { domain: searchDomain, clientScope: clientId, limit });
  const points = [];
  const unsupported = [];

  for (const entry of entries) {
    const claims = evidence.forEntry(db, entry.id);
    if (!claims.length) {
      // A KB entry with no evidence behind it is a defect, surfaced rather than quietly used.
      unsupported.push({
        kb_entry_id: entry.id,
        statement: entry.title,
        reason: 'no claim in the evidence ledger backs this entry',
      });
      continue;
    }
    for (const claim of claims) {
      if (!claim.citations.length) {
        unsupported.push({ kb_entry_id: entry.id, claim_id: claim.id, statement: claim.statement, reason: 'claim has no citations' });
        continue;
      }
      points.push({
        statement: claim.statement,
        detail: entry.body,
        domain: entry.domain,
        kb_entry_id: entry.id,
        kb_status: entry.status,
        claim_id: claim.id,
        confidence: Math.round(evidence.decayedConfidence(claim) * 100) / 100,
        stated_confidence: claim.confidence,
        freshness_days: claim.freshness_days,
        relevance: Math.round(entry.score * 100) / 100,
        citations: claim.citations.map((c) => ({
          source_id: c.source_id,
          source_name: c.source_name,
          source_kind: c.source_kind,
          artifact_id: c.artifact_id,
          locator: c.locator || c.artifact_uri,
          quote: c.quote,
          observed_at: c.fetched_at,
        })),
      });
    }
  }

  points.sort((a, b) => (b.relevance * b.confidence) - (a.relevance * a.confidence));

  const clientContext = clientId
    ? clientCorpus.search(db, principal, question, { clientId, limit: 5 }).map((row) => ({
        corpus_id: row.id, kind: row.kind, title: row.title, snippet: row.snippet,
        source_ref: row.source_ref, relevance: Math.round(row.score * 100) / 100,
      }))
    : [];

  const relatedTrends = trendsStore.recent(db, 50)
    .map((t) => ({ ...t, score_match: coverage(question, `${t.subject} ${t.summary}`) }))
    .filter((t) => t.score_match >= 0.3)
    .slice(0, 3)
    .map((t) => ({ id: t.id, kind: t.kind, subject: t.subject, summary: t.summary, state: t.state }));

  const openQuestions = inquiryStore.open(db, { limit: 50 })
    .filter((q) => coverage(question, q.question) >= 0.4)
    .slice(0, 3)
    .map((q) => ({ id: q.id, question: q.question, status: q.status, origin: q.origin }));

  const output = {
    question,
    routed_domain: routed,
    client_id: clientId,
    points: points.slice(0, limit),
    client_context: clientContext,
    related_trends: relatedTrends,
    open_questions: openQuestions,
    unsupported,
    checkable: unsupported.length === 0,
    // What the answer is allowed to be used for, decided here rather than by the caller.
    disclosure: {
      contains_client_material: clientContext.length > 0,
      report_safe: clientContext.length === 0,
      principal: principal.id,
      generated_at: now(),
    },
  };

  const runId = id('rsn');
  run(db, `INSERT INTO reasoning_runs (id, question, client_id, principal_json, output_json, supported, unsupported, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    runId, question, clientId, JSON.stringify(principal), JSON.stringify(output),
    output.points.length, unsupported.length, now());

  return { runId, ...output };
}

const runs = (db, limit = 25) => all(db, 'SELECT * FROM reasoning_runs ORDER BY created_at DESC LIMIT ?', limit);

/** Plain-text rendering with inline citation markers — the form a human actually checks. */
function render(result) {
  const lines = [`Q: ${result.question}`, ''];
  if (!result.points.length) lines.push('No cited answer available. This is a gap, not a "no".');

  result.points.forEach((point, i) => {
    const cites = point.citations.map((c) => c.source_name || c.source_id).join(', ');
    lines.push(`${i + 1}. ${point.statement}`);
    lines.push(`   confidence ${point.confidence} · evidence ${point.freshness_days}d old · sources: ${cites}`);
  });

  if (result.client_context.length) {
    lines.push('', 'Client context:');
    for (const row of result.client_context) lines.push(`   - [${row.kind}] ${row.title}: ${row.snippet.slice(0, 160)}`);
  }
  if (result.related_trends.length) {
    lines.push('', 'Related trends:');
    for (const t of result.related_trends) lines.push(`   - (${t.kind}) ${t.summary}`);
  }
  if (result.unsupported.length) {
    lines.push('', `Unsupported (${result.unsupported.length}) — not presented as answers:`);
    for (const u of result.unsupported) lines.push(`   ! ${u.statement} — ${u.reason}`);
  }
  return lines.join('\n');
}

module.exports = { ask, runs, render };
