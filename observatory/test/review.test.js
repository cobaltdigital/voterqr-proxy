'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeDb, addSource, addArtifact } = require('./helpers');
const { all, get } = require('../src/db');
const policy = require('../src/core/policy');
const curationWorker = require('../src/staging/curationWorker');
const review = require('../src/staging/review');
const domainKb = require('../src/stores/domainKb');

const reviewer = policy.principal({ id: 'rev@agency', role: 'reviewer', clientScope: ['*'] });
const analyst = policy.principal({ id: 'ana@agency', role: 'analyst', clientScope: ['*'] });

const TEXT = 'Audit the Google Business Profile category and NAP citation consistency before touching local pack ranking.';

/** Queues one low-trust candidate and returns its review item. */
function queueOne(db, overrides = {}) {
  const sourceId = addSource(db, { kind: 'public_web', collector: 'scraper', trust: 0.3 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: TEXT, domain: 'local_business', ...overrides });
  curationWorker.run(db);
  return get(db, `SELECT * FROM review_queue WHERE state = 'open'`);
}

test('accepting promotes the candidate and records a cited claim', () => {
  const db = makeDb();
  const item = queueOne(db);

  const result = review.decide(db, item.id, { principal: reviewer, decision: 'accepted' });

  assert.ok(result.kbEntryId);
  assert.ok(result.claimId);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM citations WHERE claim_id = ?', result.claimId).n, 1);
  assert.equal(get(db, 'SELECT state FROM review_queue WHERE id = ?', item.id).state, 'decided');
});

test('accepting with detail merges the reviewer note into the entry body', () => {
  const db = makeDb();
  const item = queueOne(db);

  const result = review.decide(db, item.id, {
    principal: reviewer, decision: 'accepted_with_detail', detail: 'Applies to service-area businesses only.',
  });

  assert.match(domainKb.byId(db, result.kbEntryId).body, /service-area businesses only/);
});

test('accepting with detail requires the detail', () => {
  const db = makeDb();
  const item = queueOne(db);
  assert.throws(() => review.decide(db, item.id, { principal: reviewer, decision: 'accepted_with_detail' }), /requires detail/);
});

test('declining keeps it out of the KB and rejects the artifact', () => {
  const db = makeDb();
  const item = queueOne(db);

  review.decide(db, item.id, { principal: reviewer, decision: 'declined', rationale: 'unverified' });

  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM kb_entries').n, 0);
  assert.equal(get(db, 'SELECT state FROM candidates WHERE id = ?', item.candidate_id).state, 'declined');
  assert.equal(get(db, 'SELECT state FROM staging_artifacts').state, 'rejected');
});

test('legacy accepts the entry but marks it not-current', () => {
  const db = makeDb();
  const item = queueOne(db);

  const result = review.decide(db, item.id, { principal: reviewer, decision: 'legacy' });

  assert.equal(domainKb.byId(db, result.kbEntryId).status, 'legacy');
  assert.equal(domainKb.current(db, { domain: 'local_business' }).length, 0);
});

test('superseding flips the old entry and versions the new one', () => {
  const db = makeDb();
  const trusted = addSource(db, { trust: 0.95 });
  addArtifact(db, trusted, { title: 'Local pack citation audit', text: TEXT, domain: 'local_business' });
  curationWorker.run(db);
  const original = domainKb.current(db, { domain: 'local_business' })[0];

  const item = queueOne(db, { title: 'Local pack citation audit revised', text: `${TEXT} Category match now outweighs citations.` });
  const result = review.decide(db, item.id, { principal: reviewer, decision: 'superseded', supersedesId: original.id });

  assert.equal(domainKb.byId(db, original.id).status, 'superseded');
  const replacement = domainKb.byId(db, result.kbEntryId);
  assert.equal(replacement.supersedes_id, original.id);
  assert.equal(replacement.version, original.version + 1);
  assert.equal(domainKb.current(db, { domain: 'local_business' }).length, 1);
});

test('superseding without a target is refused', () => {
  const db = makeDb();
  const item = queueOne(db);
  assert.throws(() => review.decide(db, item.id, { principal: reviewer, decision: 'superseded' }), /requires supersedesId/);
});

test('escalating to critical leaves the item open for someone else', () => {
  const db = makeDb();
  const item = queueOne(db);

  review.decide(db, item.id, { principal: reviewer, decision: 'critical', rationale: 'needs legal input' });

  const after = get(db, 'SELECT * FROM review_queue WHERE id = ?', item.id);
  assert.equal(after.state, 'open');
  assert.equal(after.severity, 'critical');
  assert.equal(review.decisionsFor(db, item.id).length, 1);
});

test('an analyst cannot decide review items', () => {
  const db = makeDb();
  const item = queueOne(db);
  assert.throws(() => review.decide(db, item.id, { principal: analyst, decision: 'accepted' }), /below required reviewer/);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM kb_entries').n, 0);
});

test('the same item cannot be decided twice', () => {
  const db = makeDb();
  const item = queueOne(db);
  review.decide(db, item.id, { principal: reviewer, decision: 'accepted' });
  assert.throws(() => review.decide(db, item.id, { principal: reviewer, decision: 'declined' }), /already decided/);
});

test('an unknown decision is refused', () => {
  const db = makeDb();
  const item = queueOne(db);
  assert.throws(() => review.decide(db, item.id, { principal: reviewer, decision: 'maybe' }), /unknown decision/);
});

test('every decision is attributed to the deciding principal', () => {
  const db = makeDb();
  const item = queueOne(db);
  review.decide(db, item.id, { principal: reviewer, decision: 'accepted' });

  const decisions = review.decisionsFor(db, item.id);
  assert.equal(decisions[0].actor, reviewer.id);
  const trail = all(db, `SELECT * FROM promotion_audit WHERE object_type = 'review'`);
  assert.equal(trail[0].actor, reviewer.id);
});
