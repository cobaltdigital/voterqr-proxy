'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDb, addClient } = require('./helpers');
const { all, get, run } = require('../src/db');
const { id, now } = require('../src/core/util');
const pipeline = require('../src/pipeline');
const collection = require('../src/collection');
const fetchPolicy = require('../src/collection/fetchPolicy');
const knowledgeGraph = require('../src/stores/knowledgeGraph');

const PAGE = `<!doctype html><html><head><title>Local pack changes</title></head>
<body><h1>Local pack changes</h1><p>Google Business Profile category match now outweighs citation
consistency for local pack ranking in service area businesses.</p></body></html>`;

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-test-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

function addSourceRow(db, { sourceId = id('src'), kind, name, collector, config, trust = 0.8, clientId = null }) {
  run(db, `INSERT INTO sources (id, kind, name, collector, config_json, trust, rate_limit_per_min, enabled, client_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 60, 1, ?, ?)`,
    sourceId, kind, name, collector, JSON.stringify(config), trust, clientId, now());
  return sourceId;
}

test('a full pass moves data from sources to curated stores and outputs', async () => {
  const db = makeDb();
  fetchPolicy.reset();
  addClient(db, { clientId: 'acme', name: 'Acme Co' });

  const knowledgeDir = tempDir({
    'local-pack.md': `---\ntitle: Local pack recovery playbook\ndomain: local_business\ntype: playbook\n---\n` +
      'Audit the Google Business Profile category and NAP citation consistency before anything else.',
  });
  const pageDir = tempDir({ 'page.html': PAGE });
  const clientDir = tempDir({
    'acme.json': JSON.stringify([{ id: 'm1', kind: 'meeting', title: 'Acme kickoff', body: 'Client wants more inbound calls from the local pack.' }]),
  });

  addSourceRow(db, { kind: 'internal_knowledge', name: 'KB', collector: 'knowledge_import', config: { dir: knowledgeDir }, trust: 0.9 });
  addSourceRow(db, { kind: 'public_web', name: 'Competitor', collector: 'scraper', trust: 0.4,
    config: { urls: ['https://competitor.example.com/post'], fixture: path.join(pageDir, 'page.html'), allow_hosts: ['competitor.example.com'] } });
  addSourceRow(db, { kind: 'marketing_api', name: 'Signals', collector: 'api_connector', config: { connector: 'mock', days: 24, freshness_hours: 0 } });
  addSourceRow(db, { kind: 'client_system', name: 'Acme systems', collector: 'client_indexer', trust: 0.8,
    clientId: 'acme', config: { dir: clientDir, client_id: 'acme' } });

  const result = await pipeline.runAll(db);

  assert.ok(result.curation.processed > 20, 'artifacts should reach curation');
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM kb_entries WHERE status = 'current'`).n, 1, 'the trusted playbook auto-promotes');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM client_corpus').n, 1, 'the client meeting is indexed by client');
  assert.ok(get(db, 'SELECT COUNT(*) AS n FROM market_activity').n > 50, 'connector signals are recorded');
  assert.ok(get(db, `SELECT COUNT(*) AS n FROM review_queue WHERE state = 'open'`).n >= 1, 'the low-trust page waits for a human');
  assert.ok(result.trends.patterns + result.trends.anomalies + result.trends.correlations > 0);
  assert.ok(result.graph.nodes > 0);

  // Raw payloads stay in staging; the corpus keeps a snippet and a ref back to the artifact.
  const corpusRow = get(db, 'SELECT * FROM client_corpus');
  assert.ok(get(db, 'SELECT id FROM staging_artifacts WHERE id = ?', corpusRow.source_ref), 'source_ref must resolve to an artifact');
});

test('a second pass is a no-op — nothing is collected, promoted or detected twice', async () => {
  const db = makeDb();
  fetchPolicy.reset();
  const dir = tempDir({
    'sop.md': `---\ntitle: Crawl budget SOP\ndomain: seo\ntype: sop\n---\n` +
      'Check the sitemap, canonical tags and crawl budget for large ecommerce catalogues before an index audit.',
  });
  addSourceRow(db, { kind: 'internal_knowledge', name: 'KB', collector: 'knowledge_import', config: { dir }, trust: 0.9 });

  await pipeline.runAll(db);
  const afterFirst = pipeline.overview(db);
  const second = await pipeline.runAll(db);

  assert.equal(second.curation.processed, 0);
  assert.deepEqual(pipeline.overview(db).stores.kb_entries, afterFirst.stores.kb_entries);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM staging_artifacts').n, 1, 'unchanged content is not re-staged');
});

test('one failing source does not stop the others', async () => {
  const db = makeDb();
  fetchPolicy.reset();
  const dir = tempDir({ 'sop.md': `---\ntitle: Crawl budget SOP\ndomain: seo\ntype: sop\n---\nCheck the sitemap and canonical tags.` });
  addSourceRow(db, { kind: 'internal_knowledge', name: 'KB', collector: 'knowledge_import', config: { dir }, trust: 0.9 });
  addSourceRow(db, { sourceId: 'src_broken', kind: 'marketing_api', name: 'Broken', collector: 'api_connector', config: { connector: 'dataforseo' } });

  const results = await collection.collectAll(db);

  const broken = results.find((r) => r.sourceId === 'src_broken');
  assert.match(broken.error, /missing credentials|not implemented/);
  assert.ok(results.some((r) => r.items === 1), 'the healthy source still collected');
  assert.equal(get(db, `SELECT status FROM collection_runs WHERE source_id = 'src_broken'`) || null, null,
    'a source that never started a run leaves no half-open run behind');
});

test('the scraper refuses hosts outside the source allowlist', async () => {
  const db = makeDb();
  fetchPolicy.reset();
  const pageDir = tempDir({ 'page.html': PAGE });
  addSourceRow(db, { sourceId: 'src_scraper', kind: 'public_web', name: 'Scraper', collector: 'scraper',
    config: { urls: ['https://not-allowed.example.net/post'], fixture: path.join(pageDir, 'page.html'), allow_hosts: ['competitor.example.com'] } });

  const result = await collection.collectSource(db, 'src_scraper');

  assert.equal(result.items, 0);
  assert.equal(result.skipped[0].reason, 'host_not_allowed');
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM staging_artifacts').n, 0);
});

test('rate limiting is enforced per source', () => {
  const source = { id: 'src_rate', rate_limit_per_min: 2, config_json: '{}' };
  const t0 = Date.now();
  assert.equal(fetchPolicy.takeToken(source, t0).ok, true);
  assert.equal(fetchPolicy.takeToken(source, t0).ok, true);
  assert.equal(fetchPolicy.takeToken(source, t0).ok, false);
  assert.equal(fetchPolicy.takeToken(source, t0 + 60000).ok, true, 'the bucket refills over time');
  fetchPolicy.reset();
});

test('the knowledge graph links entries to the sources behind their claims', async () => {
  const db = makeDb();
  fetchPolicy.reset();
  const dir = tempDir({
    'sop.md': `---\ntitle: Crawl budget SOP\ndomain: seo\ntype: sop\n---\n` +
      'Check the sitemap, canonical tags and crawl budget for large ecommerce catalogues.',
  });
  addSourceRow(db, { kind: 'internal_knowledge', name: 'KB', collector: 'knowledge_import', config: { dir }, trust: 0.9 });
  await pipeline.runAll(db);

  const hits = knowledgeGraph.search(db, 'crawl budget sitemap');
  assert.ok(hits.length >= 1);
  const { outgoing } = knowledgeGraph.neighbours(db, hits.find((h) => h.type === 'kb_entry').id);
  assert.ok(outgoing.some((edge) => edge.rel === 'supported_by'));
  assert.ok(all(db, `SELECT * FROM graph_edges WHERE rel = 'cites'`).length >= 1);
});
