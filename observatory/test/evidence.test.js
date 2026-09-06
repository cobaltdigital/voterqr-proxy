'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeDb, addSource, addArtifact, daysAgo } = require('./helpers');
const { get } = require('../src/db');
const evidence = require('../src/stores/evidenceLedger');
const domainKb = require('../src/stores/domainKb');
const curationWorker = require('../src/staging/curationWorker');
const policy = require('../src/core/policy');
const reasoningLayer = require('../src/reasoning/reasoningLayer');

const admin = policy.principal({ id: 'admin', role: 'admin', clientScope: ['*'] });
const TEXT = 'Audit the Google Business Profile category and NAP citation consistency before touching local pack ranking.';

test('a claim without citations is refused outright', () => {
  const db = makeDb();
  assert.throws(() => evidence.assert(db, { statement: 'Local pack rankings improved', citations: [] }), /uncited claim/);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM claims').n, 0);
});

test('every promoted KB entry arrives with a cited claim attached', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.9 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: TEXT, domain: 'local_business' });
  curationWorker.run(db);

  const entry = domainKb.current(db, { domain: 'local_business' })[0];
  const claims = evidence.forEntry(db, entry.id);

  assert.equal(claims.length, 1);
  assert.equal(claims[0].citations.length, 1);
  assert.equal(claims[0].citations[0].source_id, sourceId);
  assert.equal(evidence.stats(db).uncited, 0);
});

test('confidence decays as the evidence behind it ages', () => {
  const fresh = { confidence: 0.8, freshness_at: new Date().toISOString() };
  const old = { confidence: 0.8, freshness_at: daysAgo(360) };

  assert.ok(evidence.decayedConfidence(fresh) > 0.79);
  assert.ok(evidence.decayedConfidence(old) < 0.25, 'a year-old citation should not still read as 0.8');
});

test('stale claims are listed for re-verification', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.9 });
  evidence.assert(db, {
    statement: 'Citations outweigh category match',
    domain: 'local_business',
    citations: [{ sourceId, observedAt: daysAgo(400) }],
  });

  const stale = evidence.stale(db, { olderThanDays: 180 });
  assert.equal(stale.length, 1);
  assert.ok(stale[0].freshness_days > 360);
});

test('the reasoning layer presents only cited points', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.9 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: TEXT, domain: 'local_business' });
  curationWorker.run(db);

  const result = reasoningLayer.ask(db, { question: 'How do we audit local pack citation consistency?', principal: admin });

  assert.ok(result.points.length >= 1);
  assert.ok(result.points.every((p) => p.citations.length > 0));
  assert.equal(result.unsupported.length, 0);
  assert.equal(result.checkable, true);
});

test('a KB entry with no evidence is reported as unsupported, never as an answer', () => {
  const db = makeDb();
  // Written directly to the store, bypassing promotion — the case the reasoning layer must catch.
  domainKb.create(db, {
    domain: 'local_business', type: 'fact',
    title: 'Local pack citation consistency drives ranking',
    body: 'Asserted without any source behind it.',
    actor: 'test',
  });

  const result = reasoningLayer.ask(db, { question: 'What drives local pack citation consistency ranking?', principal: admin });

  assert.equal(result.points.length, 0);
  assert.equal(result.unsupported.length, 1);
  assert.equal(result.checkable, false);
  assert.match(result.unsupported[0].reason, /no claim in the evidence ledger/);
});

test('reasoning runs are persisted with their supported/unsupported counts', () => {
  const db = makeDb();
  domainKb.create(db, { domain: 'seo', type: 'fact', title: 'Crawl budget matters for large sitemaps', body: 'x', actor: 'test' });
  reasoningLayer.ask(db, { question: 'Does crawl budget matter for large sitemaps?', principal: admin });

  const run = get(db, 'SELECT * FROM reasoning_runs');
  assert.equal(run.unsupported, 1);
  assert.equal(run.supported, 0);
  assert.equal(JSON.parse(run.principal_json).id, admin.id);
});
