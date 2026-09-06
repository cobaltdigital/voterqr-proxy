'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeDb, addSource } = require('./helpers');
const { all } = require('../src/db');
const marketActivity = require('../src/stores/marketActivity');
const trendsWorker = require('../src/staging/trendsWorker');
const trendsStore = require('../src/stores/trendsStore');
const stats = require('../src/staging/stats');

const day = (n) => new Date(Date.UTC(2026, 0, 1) + n * 86400000).toISOString();

/** Appends a daily series for one subject+signal. */
function series(db, sourceId, subject, signal, values, { domain = 'seo', channel = 'serp' } = {}) {
  values.forEach((value, i) => marketActivity.append(db, {
    observedAt: day(i), channel, subject, signal, value, unit: 'pct', sourceId, meta: { domain },
  }));
}

test('statistics helpers behave', () => {
  assert.equal(stats.mean([2, 4, 6]), 4);
  assert.ok(Math.abs(stats.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
  assert.ok(Math.abs(stats.pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9);
  const fit = stats.linearRegression([1, 2, 3, 4, 5]);
  assert.ok(Math.abs(fit.slope - 1) < 1e-9);
  assert.ok(fit.r2 > 0.999);
});

test('a sudden outlier is detected as an anomaly and escalated to a human', () => {
  const db = makeDb();
  const sourceId = addSource(db, { kind: 'marketing_api', collector: 'api_connector' });
  const flat = Array.from({ length: 20 }, (_, i) => 10 + (i % 2 ? 0.4 : -0.4));
  series(db, sourceId, 'ai overview presence', 'appearance_rate', [...flat, 48]);

  const summary = trendsWorker.run(db);

  assert.equal(summary.anomalies, 1);
  const detection = trendsStore.recent(db)[0];
  assert.equal(detection.kind, 'anomaly');
  assert.equal(detection.action, 'review');
  assert.equal(all(db, `SELECT * FROM review_queue WHERE state = 'open' AND severity = 'critical'`).length, 1,
    'an anomaly should reach the review gate, not just a dashboard');
});

test('a sustained directional move is detected as a pattern and watched', () => {
  const db = makeDb();
  const sourceId = addSource(db, { kind: 'marketing_api', collector: 'api_connector' });
  series(db, sourceId, 'local pack rank', 'avg_position', Array.from({ length: 24 }, (_, i) => 8 - i * 0.15));

  const summary = trendsWorker.run(db);

  assert.equal(summary.patterns, 1);
  assert.equal(summary.anomalies, 0, 'a smooth trend is not an outlier');
  assert.equal(trendsStore.watchlist(db).length, 1);
});

test('flat noise produces no detections', () => {
  const db = makeDb();
  const sourceId = addSource(db, { kind: 'marketing_api', collector: 'api_connector' });
  series(db, sourceId, 'ctr', 'organic_ctr', Array.from({ length: 20 }, (_, i) => 4 + (i % 3) * 0.02));

  const summary = trendsWorker.run(db);

  assert.equal(summary.anomalies + summary.patterns + summary.correlations, 0);
});

test('a series shorter than the minimum is ignored', () => {
  const db = makeDb();
  const sourceId = addSource(db, { kind: 'marketing_api', collector: 'api_connector' });
  series(db, sourceId, 'ctr', 'organic_ctr', [4, 9, 2, 40]);

  assert.equal(trendsWorker.run(db).series, 0);
});

test('cross-domain correlation becomes an experiment, never a fact', () => {
  const db = makeDb();
  const sourceId = addSource(db, { kind: 'marketing_api', collector: 'api_connector' });
  const base = Array.from({ length: 20 }, (_, i) => 10 + i * 0.5);
  series(db, sourceId, 'ai overview presence', 'appearance_rate', base, { domain: 'ai' });
  series(db, sourceId, 'organic clicks', 'clicks', base.map((v) => 100 - v * 2), { domain: 'seo' });

  const summary = trendsWorker.run(db);

  assert.ok(summary.correlations >= 1);
  const correlation = trendsStore.recent(db, 20).find((d) => d.kind === 'correlation');
  assert.equal(correlation.action, 'experiment');
  const inquiries = all(db, `SELECT * FROM inquiries WHERE origin = 'ai' AND status = 'experiment'`);
  assert.equal(inquiries.length, 1, 'a correlation should open a question, not assert a cause');
  assert.equal(all(db, 'SELECT COUNT(*) AS n FROM kb_entries')[0].n, 0);
});

test('a persistent shift does not re-alert on every run', () => {
  const db = makeDb();
  const sourceId = addSource(db, { kind: 'marketing_api', collector: 'api_connector' });
  series(db, sourceId, 'local pack rank', 'avg_position', Array.from({ length: 24 }, (_, i) => 8 - i * 0.15));

  const first = trendsWorker.run(db);
  const second = trendsWorker.run(db);

  assert.equal(first.patterns, 1);
  assert.equal(second.patterns, 0, 'cooldown should suppress the repeat detection');
});

test('the market activity store exposes no way to mutate an observation', () => {
  const exported = Object.keys(marketActivity);
  assert.deepEqual(exported.filter((k) => /update|delete|remove|set/i.test(k)), []);
});
