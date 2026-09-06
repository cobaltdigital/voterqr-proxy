'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Demo runs against its own database so it never disturbs a working one.
const DEMO_DB = path.join(__dirname, '..', 'data', 'demo.db');
process.env.OBSERVATORY_DB = DEMO_DB;
process.env.OBSERVATORY_OFFLINE = '1';
process.env.OBSERVATORY_LOG_LEVEL = process.env.OBSERVATORY_LOG_LEVEL || 'warn';

const dbModule = require('../src/db');
const policy = require('../src/core/policy');
const pipeline = require('../src/pipeline');
const review = require('../src/staging/review');
const reasoningLayer = require('../src/reasoning/reasoningLayer');
const workflows = require('../src/reasoning/workflows');
const reporting = require('../src/reasoning/reporting');
const strategy = require('../src/reasoning/strategy');
const { seed } = require('./seed');

const heading = (text) => console.log(`\n\x1b[1m── ${text} ${'─'.repeat(Math.max(0, 66 - text.length))}\x1b[0m`);

async function main() {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DEMO_DB + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  const db = dbModule.open(DEMO_DB);
  const reviewer = policy.principal({ id: 'demo.reviewer', role: 'reviewer', clientScope: ['*'] });

  heading('1. Seed sources');
  console.log(seed(db));

  heading('2. Full pipeline pass');
  const result = await pipeline.runAll(db);
  console.log(`collected from ${result.collection.length} sources`);
  console.log(`curation: ${result.curation.processed} artifacts → ${result.curation.promoted} auto-promoted, ` +
              `${result.curation.queued} queued for review, ${result.curation.duplicates} deduped`);
  console.log(`status:   ${result.status.contradictions} contradictions, ${result.status.supersessions} supersessions, ` +
              `${result.status.staleClaims} stale claims`);
  console.log(`trends:   ${result.trends.anomalies} anomalies, ${result.trends.patterns} patterns, ` +
              `${result.trends.correlations} correlations across ${result.trends.series} series`);
  console.log(`graph:    ${result.graph.nodes} nodes, ${result.graph.edges} edges`);

  heading('3. What is waiting on a human');
  const queue = review.open(db);
  for (const item of queue.slice(0, 8)) {
    console.log(`[${item.severity}] ${item.reason}: ${item.title || '(kb entry)'}`);
    if (item.detail) console.log(`    ${item.detail.split('\n')[0]}`);
  }
  console.log(`…${queue.length} item(s) open in total`);

  heading('4. A reviewer decides');
  const acceptable = queue.find((i) => i.reason === 'low_trust' && i.candidate_id);
  if (acceptable) {
    const decision = review.decide(db, acceptable.id, {
      principal: reviewer, decision: 'accepted_with_detail',
      detail: 'Verified against the source page; applies to service-area businesses only.',
      rationale: 'Public source, but the claim matches our own local pack observations.',
    });
    console.log(`accepted "${acceptable.title}" → kb entry ${decision.kbEntryId}, claim ${decision.claimId}`);
  }
  const risky = queue.find((i) => i.severity === 'critical' && i.candidate_id);
  if (risky) {
    review.decide(db, risky.id, {
      principal: reviewer, decision: 'declined',
      rationale: 'Commercial and confidentiality risk — must not enter the shared knowledge base.',
    });
    console.log(`declined "${risky.title}"`);
  }

  heading('5. Ask the reasoning layer');
  const answer = reasoningLayer.ask(db, {
    question: 'What should we do about a local pack drop after a Google Business Profile category change?',
    principal: reviewer,
    clientId: 'northside-dental',
  });
  console.log(reasoningLayer.render(answer));

  heading('6. Draft actions from that answer');
  const drafts = workflows.fromReasoning(db, answer, { clientId: 'northside-dental' });
  const siteChanges = workflows.list(db, { status: 'draft' }).filter((d) => d.kind === 'site_change');
  console.log(`${drafts.length} action draft(s) from the answer, ${siteChanges.length} site-change record(s) from watched trends`);
  console.log('all require approval before dispatch — none can execute on their own');

  heading('7. Weekly market brief (report-safe)');
  console.log(reporting.weeklyBrief(db, { safe: true }).body);

  heading('8. Public-safe opportunity brief');
  console.log(strategy.opportunityBrief(db, { principal: reviewer, publicSafe: true }).body);

  heading('9. Where everything ended up');
  const overview = pipeline.overview(db);
  console.log(JSON.stringify({
    staging: overview.staging,
    stores: overview.stores,
    outputs: overview.outputs,
    audited_transitions: overview.audit.transitions,
  }, null, 2));

  console.log(`\nDemo database: ${DEMO_DB}`);
  console.log(`Explore it: OBSERVATORY_DB=${DEMO_DB} node bin/observatory.js serve`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
