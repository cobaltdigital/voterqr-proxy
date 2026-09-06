'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeDb, addSource, daysAgo } = require('./helpers');
const { all, get } = require('../src/db');
const domainKb = require('../src/stores/domainKb');
const evidence = require('../src/stores/evidenceLedger');
const statusWorker = require('../src/staging/statusWorker');

const CWV_SOP = 'Core Web Vitals on mobile field data: LCP under 2.5s for templated landing pages, INP under 200ms, CLS under 0.1.';
const CWV_REVISED = 'Core Web Vitals on mobile field data: LCP under 4s is acceptable for templated landing pages with video, INP under 200ms, CLS under 0.1.';

const entry = (db, title, body, extra = {}) =>
  domainKb.create(db, { domain: 'web_design', type: 'fact', title, body, actor: 'test', ...extra });

test('two current entries with conflicting numbers are flagged for a human', () => {
  const db = makeDb();
  entry(db, 'Core Web Vitals thresholds', CWV_SOP);
  entry(db, 'Revised Core Web Vitals thresholds', CWV_REVISED);

  const summary = statusWorker.run(db);

  assert.equal(summary.contradictions, 1);
  const item = get(db, `SELECT * FROM review_queue WHERE reason = 'contradiction'`);
  assert.equal(item.severity, 'critical');
  assert.match(item.detail, /numeric conflict/);
});

test('the status worker never flips a status by itself', () => {
  const db = makeDb();
  entry(db, 'Core Web Vitals thresholds', CWV_SOP);
  entry(db, 'Revised Core Web Vitals thresholds', CWV_REVISED);

  statusWorker.run(db);

  assert.equal(domainKb.current(db, { domain: 'web_design' }).length, 2,
    'resolving a contradiction is a human decision, not an automatic supersession');
});

test('unrelated entries in the same domain are not flagged', () => {
  const db = makeDb();
  entry(db, 'Core Web Vitals thresholds', CWV_SOP);
  entry(db, 'Accessible form labelling', 'Every input needs a programmatically associated label element for screen readers.');

  assert.equal(statusWorker.run(db).contradictions, 0);
});

test('bare numbers in prose do not count as a numeric conflict', () => {
  const a = { title: 'Local pack recovery', body: 'Profile edits settle in one to three weeks. Step 2 is the citation audit.' };
  const b = { title: 'Local pack recovery notes', body: 'Profile edits settle in two to three weeks. Step 4 is the citation audit.' };

  assert.equal(statusWorker.numericConflict(a, b), null);
});

test('unit-bearing numbers do count', () => {
  const conflict = statusWorker.numericConflict(
    { title: 'LCP target', body: 'LCP under 2.5s on mobile.' },
    { title: 'LCP target', body: 'LCP under 4s on mobile.' },
  );
  assert.ok(conflict);
  assert.equal(conflict.a.unit, 's');
});

test('a negated restatement is treated as a contradiction', () => {
  const db = makeDb();
  entry(db, 'Citation consistency', 'Citation consistency across directories should be audited for every local client every quarter.');
  entry(db, 'Citation consistency revisited', 'Citation consistency across directories should not be audited for local clients every quarter.');

  assert.equal(statusWorker.run(db).contradictions, 1);
});

test('the same pair is not re-flagged while its review item is open', () => {
  const db = makeDb();
  entry(db, 'Core Web Vitals thresholds', CWV_SOP);
  entry(db, 'Revised Core Web Vitals thresholds', CWV_REVISED);

  statusWorker.run(db);
  statusWorker.run(db);

  assert.equal(all(db, `SELECT * FROM review_queue WHERE reason = 'contradiction'`).length, 1);
});

test('entries scoped to different clients are not compared with each other', () => {
  const db = makeDb();
  entry(db, 'Core Web Vitals thresholds', CWV_SOP, { clientScope: 'acme' });
  entry(db, 'Revised Core Web Vitals thresholds', CWV_REVISED, { clientScope: 'globex' });

  assert.equal(statusWorker.run(db).contradictions, 0);
});

test('an entry resting on year-old evidence is flagged for re-verification', () => {
  const db = makeDb();
  const sourceId = addSource(db);
  const entryId = entry(db, 'Core Web Vitals thresholds', CWV_SOP);
  evidence.assert(db, {
    statement: 'LCP under 2.5s on mobile', kbEntryId: entryId, domain: 'web_design',
    citations: [{ sourceId, observedAt: daysAgo(400) }],
  });

  const summary = statusWorker.run(db);

  assert.equal(summary.staleClaims, 1);
  assert.match(get(db, `SELECT * FROM review_queue WHERE reason = 'stale_evidence'`).detail, /400 days old|39\d days old/);
});
