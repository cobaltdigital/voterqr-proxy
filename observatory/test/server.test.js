'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeDb, addClient, addSource, addArtifact } = require('./helpers');
const { get } = require('../src/db');
const { createServer } = require('../src/server/app');
const curationWorker = require('../src/staging/curationWorker');
const clientCorpus = require('../src/stores/clientCorpus');

const TEXT = 'Audit the Google Business Profile category and NAP citation consistency before touching local pack ranking.';

/** Boots the API on an ephemeral port and returns a fetch helper bound to it. */
async function withServer(db, fn) {
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  try { await fn(call); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function seedPromoted(db) {
  const sourceId = addSource(db, { trust: 0.9 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: TEXT, domain: 'local_business' });
  curationWorker.run(db);
  return sourceId;
}

test('overview reports counts for every stage', async () => {
  const db = makeDb();
  seedPromoted(db);
  await withServer(db, async (call) => {
    const { status, data } = await call('GET', '/api/overview');
    assert.equal(status, 200);
    assert.equal(data.stores.kb_entries, 1);
    assert.ok(data.staging.artifacts >= 1);
    assert.ok(data.audit.transitions >= 1);
  });
});

test('asking returns cited points and records the run', async () => {
  const db = makeDb();
  seedPromoted(db);
  await withServer(db, async (call) => {
    const { data } = await call('POST', '/api/ask', { body: { question: 'How do we audit local pack citations?' } });
    assert.ok(data.points.length >= 1);
    assert.ok(data.points[0].citations.length >= 1);
    assert.equal(data.checkable, true);
    assert.ok(data.rendered.includes('Q: How do we audit'));
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM reasoning_runs').n, 1);
  });
});

test('a viewer cannot decide a review item over HTTP', async () => {
  const db = makeDb();
  const sourceId = addSource(db, { kind: 'public_web', collector: 'scraper', trust: 0.3 });
  addArtifact(db, sourceId, { title: 'Local pack citation audit', text: TEXT, domain: 'local_business' });
  curationWorker.run(db);
  const item = get(db, `SELECT id FROM review_queue WHERE state = 'open'`);

  await withServer(db, async (call) => {
    const denied = await call('POST', `/api/review/${item.id}/decide`, {
      body: { decision: 'accepted' },
      headers: { 'x-observatory-actor': 'nosy@agency', 'x-observatory-role': 'viewer' },
    });
    assert.equal(denied.status, 403);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM kb_entries').n, 0);

    const allowed = await call('POST', `/api/review/${item.id}/decide`, {
      body: { decision: 'accepted' },
      headers: { 'x-observatory-actor': 'rev@agency', 'x-observatory-role': 'reviewer' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(get(db, 'SELECT COUNT(*) AS n FROM kb_entries').n, 1);
    assert.equal(get(db, 'SELECT actor FROM review_decisions').actor, 'rev@agency');
  });
});

test('client corpus reads are scoped to the caller', async () => {
  const db = makeDb();
  addClient(db, { clientId: 'acme' });
  addClient(db, { clientId: 'globex' });
  clientCorpus.index(db, { clientId: 'globex', kind: 'meeting', title: 'Globex kickoff', snippet: 'x', sourceRef: 'art_1' });

  await withServer(db, async (call) => {
    const denied = await call('GET', '/api/corpus/globex', {
      headers: { 'x-observatory-role': 'analyst', 'x-observatory-clients': 'acme' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'client_scope');

    const allowed = await call('GET', '/api/corpus/globex', {
      headers: { 'x-observatory-role': 'analyst', 'x-observatory-clients': 'globex' },
    });
    assert.equal(allowed.data.rows.length, 1);
  });
});

test('workflow drafts require approval and record who gave it', async () => {
  const db = makeDb();
  seedPromoted(db);
  await withServer(db, async (call) => {
    const asked = await call('POST', '/api/ask', { body: { question: 'How do we audit local pack citations?', draftActions: true } });
    assert.ok(asked.data.drafts.length >= 1);

    const draftId = asked.data.drafts[0];
    const approved = await call('POST', `/api/workflows/${draftId}/approve`, {
      body: { note: 'ok' }, headers: { 'x-observatory-actor': 'rev@agency', 'x-observatory-role': 'reviewer' },
    });
    assert.equal(approved.status, 200);
    assert.equal(get(db, 'SELECT status FROM workflow_drafts WHERE id = ?', draftId).status, 'approved');
    assert.equal(get(db, `SELECT actor FROM promotion_audit WHERE object_id = ? AND to_state = 'approved'`, draftId).actor, 'rev@agency');
  });
});

test('the weekly brief can be generated report-safe', async () => {
  const db = makeDb();
  addClient(db, { clientId: 'acme', name: 'Acme Co' });
  seedPromoted(db);
  await withServer(db, async (call) => {
    const { data } = await call('POST', '/api/reports/weekly', { body: { safe: true } });
    assert.equal(data.safe, true);
    assert.match(data.body, /Weekly Market Brief/);
    assert.doesNotMatch(data.body, /Acme Co/);
  });
});

test('unknown routes 404 and bad bodies 400', async () => {
  const db = makeDb();
  await withServer(db, async (call) => {
    assert.equal((await call('GET', '/api/nope')).status, 404);
    assert.equal((await call('POST', '/api/ask', { body: {} })).status, 400);
  });
});

test('the dashboard is served at the root', async () => {
  const db = makeDb();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Observatory/);
    assert.match(html, /Human Review/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
