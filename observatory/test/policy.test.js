'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeDb, addClient } = require('./helpers');
const policy = require('../src/core/policy');
const clientCorpus = require('../src/stores/clientCorpus');

const admin = policy.principal({ id: 'admin', role: 'admin', clientScope: ['*'] });
const acmeAnalyst = policy.principal({ id: 'ana', role: 'analyst', clientScope: ['acme'] });

test('a principal needs an id and a known role', () => {
  assert.throws(() => policy.principal({}), /requires an id/);
  assert.throws(() => policy.principal({ id: 'x', role: 'wizard' }), /unknown role/);
});

test('client scope is enforced at the store, not left to callers', () => {
  const db = makeDb();
  addClient(db, { clientId: 'acme', name: 'Acme Co' });
  addClient(db, { clientId: 'globex', name: 'Globex' });
  clientCorpus.index(db, { clientId: 'acme', kind: 'meeting', title: 'Acme kickoff', snippet: 'notes', sourceRef: 'art_1' });
  clientCorpus.index(db, { clientId: 'globex', kind: 'meeting', title: 'Globex kickoff', snippet: 'notes', sourceRef: 'art_2' });

  assert.equal(clientCorpus.forClient(db, acmeAnalyst, 'acme').length, 1);
  assert.throws(() => clientCorpus.forClient(db, acmeAnalyst, 'globex'), policy.PolicyError);
  assert.equal(clientCorpus.forClient(db, admin, 'globex').length, 1);
});

test('an unscoped corpus search never returns another client\'s rows', () => {
  const db = makeDb();
  addClient(db, { clientId: 'acme' });
  addClient(db, { clientId: 'globex' });
  clientCorpus.index(db, { clientId: 'acme', kind: 'meeting', title: 'local pack strategy', snippet: 'local pack ranking work', sourceRef: 'a' });
  clientCorpus.index(db, { clientId: 'globex', kind: 'meeting', title: 'local pack strategy', snippet: 'local pack ranking work', sourceRef: 'b' });

  const results = clientCorpus.search(db, acmeAnalyst, 'local pack ranking');

  assert.equal(results.length, 1);
  assert.equal(results[0].client_id, 'acme');
});

test('row-level access parameters exclude rows even inside the client scope', () => {
  const db = makeDb();
  addClient(db, { clientId: 'acme' });
  clientCorpus.index(db, {
    clientId: 'acme', kind: 'sales', title: 'Renewal terms', snippet: 'restricted',
    sourceRef: 'art_3', access: { restricted_to: ['admin'] },
  });

  assert.equal(clientCorpus.forClient(db, acmeAnalyst, 'acme').length, 0);
  assert.equal(clientCorpus.forClient(db, admin, 'acme').length, 1);
});

test('corpus rows must carry a client and a source ref back to staging', () => {
  const db = makeDb();
  addClient(db, { clientId: 'acme' });
  assert.throws(() => clientCorpus.index(db, { kind: 'doc', title: 't', snippet: 's', sourceRef: 'a' }), /client_id/);
  assert.throws(() => clientCorpus.index(db, { clientId: 'acme', kind: 'doc', title: 't', snippet: 's' }), /source_ref/);
});

test('promotion policy: only trusted, low-risk, routed candidates auto-promote', () => {
  const promoted = policy.routeCandidate({ domain: 'seo', kind: 'fact', trust: 0.9, risk: 0.1 });
  assert.equal(promoted.state, 'promoted');

  assert.equal(policy.routeCandidate({ domain: 'seo', kind: 'fact', trust: 0.5, risk: 0.1 }).reason, 'low_trust');
  assert.equal(policy.routeCandidate({ domain: 'seo', kind: 'fact', trust: 0.9, risk: 0.4 }).reason, 'high_risk');
  assert.equal(policy.routeCandidate({ domain: 'unrouted', kind: 'fact', trust: 0.9, risk: 0.1 }).reason, 'unrouted');

  const critical = policy.routeCandidate({ domain: 'seo', kind: 'fact', trust: 0.9, risk: 0.8 });
  assert.equal(critical.severity, 'critical');
});

test('client records are exempt from the domain requirement, but not from risk', () => {
  assert.equal(policy.routeCandidate({ domain: 'unrouted', kind: 'meeting', clientId: 'acme', trust: 0.9, risk: 0.1 }).state, 'promoted');
  assert.equal(policy.routeCandidate({ domain: 'unrouted', kind: 'meeting', clientId: 'acme', trust: 0.9, risk: 0.6 }).reason, 'high_risk');
  assert.equal(policy.routeCandidate({ domain: 'unrouted', kind: 'meeting', trust: 0.9, risk: 0.1 }).reason, 'unrouted',
    'no client id means it is not client material');
});

test('report-safe rendering removes client identity', () => {
  const clients = [{ id: 'acme', name: 'Acme Co', tier: 'growth' }];
  const scrubbed = policy.reportSafe('Acme Co saw a local pack drop; acme co recovered in three weeks.', clients);

  assert.doesNotMatch(scrubbed, /acme/i);
  assert.match(scrubbed, /\[growth client\]/);
});

test('role ordering gates decisions', () => {
  assert.throws(() => policy.assertRole(policy.principal({ id: 'v', role: 'viewer' }), 'reviewer'), /below required/);
  assert.ok(policy.assertRole(policy.principal({ id: 'a', role: 'admin' }), 'reviewer'));
});
