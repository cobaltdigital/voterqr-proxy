'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeDb, addSource, addClient, addArtifact } = require('./helpers');
const { all, get } = require('../src/db');
const curationWorker = require('../src/staging/curationWorker');

const LOCAL_SOP = 'Audit the Google Business Profile category and NAP citation consistency before touching the local pack ranking.';

test('a trusted, low-risk, confidently routed artifact auto-promotes', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.9 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: LOCAL_SOP, domain: 'local_business' });

  const summary = curationWorker.run(db);

  assert.equal(summary.promoted, 1);
  assert.equal(summary.queued, 0);
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM kb_entries WHERE status = 'current'`).n, 1);
});

test('a low-trust source is queued for review instead of promoted', () => {
  const db = makeDb();
  const sourceId = addSource(db, { kind: 'public_web', collector: 'scraper', trust: 0.3 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: LOCAL_SOP, domain: 'local_business' });

  const summary = curationWorker.run(db);

  assert.equal(summary.promoted, 0);
  assert.equal(summary.queued, 1);
  const item = get(db, `SELECT * FROM review_queue WHERE state = 'open'`);
  assert.equal(item.reason, 'low_trust');
  assert.match(item.detail, /trust 0\.\d+/);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM kb_entries').n, 0);
});

test('risky content is escalated to critical review however trusted the source', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 1 });
  addArtifact(db, sourceId, {
    title: 'Guaranteed ROAS pricing for paid ads retainers',
    text: 'Confidential: our paid ads retainer pricing guarantees a 3x ROAS improvement. Do not share externally.',
    domain: 'paid_ads',
  });

  curationWorker.run(db);

  const item = get(db, `SELECT * FROM review_queue WHERE state = 'open'`);
  assert.equal(item.severity, 'critical');
  assert.equal(item.reason, 'high_risk');
});

test('an unroutable artifact goes to review rather than into an arbitrary domain', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.95 });
  addArtifact(db, sourceId, { title: 'Q3 notes', text: 'Miscellaneous notes with no domain signal at all.' });

  curationWorker.run(db);

  assert.equal(get(db, `SELECT reason FROM review_queue WHERE state = 'open'`).reason, 'unrouted');
});

test('identical content collected twice is deduped, not promoted twice', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.9 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: LOCAL_SOP, domain: 'local_business' });
  curationWorker.run(db);

  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: LOCAL_SOP, domain: 'local_business' });
  const second = curationWorker.run(db);

  assert.equal(second.duplicates, 1);
  assert.equal(second.promoted, 0);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM kb_entries').n, 1);
});

test('a near-duplicate reworded slightly is also caught', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.9 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: LOCAL_SOP, domain: 'local_business' });
  curationWorker.run(db);

  addArtifact(db, sourceId, {
    title: 'Local pack citation audit',
    text: `${LOCAL_SOP} Also check the profile.`,
    domain: 'local_business',
  });
  const second = curationWorker.run(db);

  assert.equal(second.duplicates, 1);
  assert.equal(get(db, `SELECT duplicate_of FROM candidates ORDER BY created_at DESC LIMIT 1`).duplicate_of != null, true);
});

test('client records are filed by client, not held for lacking a marketing domain', () => {
  const db = makeDb();
  const clientId = addClient(db);
  const sourceId = addSource(db, { kind: 'client_system', collector: 'client_indexer', trust: 0.8, clientId });
  addArtifact(db, sourceId, {
    title: 'Kickoff meeting notes',
    text: 'Client wants more inbound calls. Next step is a profile audit.',
    kind: 'meeting', clientId, parser: 'client.indexer',
    extra: { snippet: 'Client wants more inbound calls.' },
  });

  const summary = curationWorker.run(db);

  assert.equal(summary.promoted, 1);
  const rows = all(db, 'SELECT * FROM client_corpus');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, clientId);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM kb_entries').n, 0, 'client material must not land in the shared KB');
});

test('a candidate no store can hold is queued, never marked promoted into nothing', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.99 });
  addArtifact(db, sourceId, {
    title: 'Local pack citation audit', text: LOCAL_SOP, domain: 'local_business',
    kind: 'unknown_kind_from_a_future_parser',
  });

  const summary = curationWorker.run(db);

  assert.equal(summary.promoted, 0);
  assert.equal(summary.queued, 1);
  assert.equal(get(db, `SELECT reason FROM review_queue WHERE state = 'open'`).reason, 'unhandled_kind');
  assert.equal(get(db, `SELECT state FROM candidates`).state, 'in_review');
});

test('every promotion and queueing decision is written to the audit trail', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.9 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: LOCAL_SOP, domain: 'local_business' });
  curationWorker.run(db);

  const trail = all(db, 'SELECT * FROM promotion_audit ORDER BY created_at');
  assert.ok(trail.some((row) => row.object_type === 'candidate' && row.to_state === 'promoted'));
  assert.ok(trail.some((row) => row.object_type === 'kb_entry'));
  assert.ok(trail.every((row) => row.actor));
});

test('a second pass over already-curated artifacts does nothing', () => {
  const db = makeDb();
  const sourceId = addSource(db, { trust: 0.9 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: LOCAL_SOP, domain: 'local_business' });
  curationWorker.run(db);

  assert.deepEqual(curationWorker.run(db), { processed: 0, promoted: 0, queued: 0, duplicates: 0 });
});
