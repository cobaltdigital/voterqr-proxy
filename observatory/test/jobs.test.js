'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeDb } = require('./helpers');
const { all, get, run } = require('../src/db');
const { id, now } = require('../src/core/util');
const jobs = require('../src/core/jobs');
const scheduler = require('../src/scheduler');
const workers = require('../src/workers');
const trendsStore = require('../src/stores/trendsStore');
const workflows = require('../src/reasoning/workflows');
const policy = require('../src/core/policy');
const fetchPolicy = require('../src/collection/fetchPolicy');

const reviewer = policy.principal({ id: 'rev@agency', role: 'reviewer', clientScope: ['*'] });

function knowledgeSource(db, { minutes = 1440, nextRunAt = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observatory-jobs-'));
  fs.writeFileSync(path.join(dir, 'sop.md'),
    '---\ntitle: Crawl budget SOP\ndomain: seo\ntype: sop\n---\n' +
    'Check the sitemap, canonical tags and crawl budget for large ecommerce catalogues.');
  const sourceId = id('src');
  run(db, `INSERT INTO sources (id, kind, name, collector, config_json, trust, rate_limit_per_min, enabled,
                                client_id, created_at, schedule_minutes, next_run_at)
           VALUES (?, 'internal_knowledge', 'KB', 'knowledge_import', ?, 0.9, 60, 1, NULL, ?, ?, ?)`,
    sourceId, JSON.stringify({ dir }), now(), minutes, nextRunAt);
  return sourceId;
}

test('a failing job backs off instead of burning its retries in one pass', async () => {
  const db = makeDb();
  jobs.enqueue(db, 'explode', {});
  const handlers = { explode: () => { throw new Error('boom'); } };

  await jobs.drain(db, handlers);

  const job = get(db, 'SELECT * FROM jobs');
  assert.equal(job.state, 'pending', 'still retryable');
  assert.equal(job.attempts, 1, 'one attempt per pass, not three');
  assert.ok(job.run_after > now(), 'the retry is scheduled into the future');
  assert.match(job.last_error, /boom/);
});

test('a failing job gives up once its attempts are exhausted', async () => {
  const db = makeDb();
  const jobId = jobs.enqueue(db, 'explode', {});
  const handlers = { explode: () => { throw new Error('boom'); } };

  for (let i = 0; i < 3; i += 1) {
    run(db, 'UPDATE jobs SET run_after = ? WHERE id = ?', now(), jobId);   // simulate the backoff elapsing
    await jobs.drain(db, handlers);
  }

  const job = get(db, 'SELECT * FROM jobs');
  assert.equal(job.state, 'failed');
  assert.equal(job.attempts, 3);
});

test('a job type with no handler fails instead of vanishing', async () => {
  const db = makeDb();
  jobs.enqueue(db, 'unknown_type', {});

  const result = await jobs.drain(db, {});

  assert.equal(result.failed, 1);
  assert.match(get(db, 'SELECT last_error FROM jobs').last_error, /no handler/);
});

test('the scheduler queues due sources and sets their next run', () => {
  const db = makeDb();
  const sourceId = knowledgeSource(db, { minutes: 60 });

  const queued = scheduler.tick(db);

  assert.equal(queued.collect, 1);
  assert.equal(queued.downstream, 4, 'curate, status, trends and graph follow a collection');
  const source = get(db, 'SELECT next_run_at FROM sources WHERE id = ?', sourceId);
  assert.ok(source.next_run_at > now(), 'next run should be in the future');
});

test('a source that is not yet due is left alone', () => {
  const db = makeDb();
  const future = new Date(Date.now() + 3600000).toISOString();
  knowledgeSource(db, { minutes: 60, nextRunAt: future });

  assert.equal(scheduler.tick(db).collect, 0);
  assert.equal(all(db, 'SELECT * FROM jobs').length, 0);
});

test('ticking twice does not queue the same source twice', () => {
  const db = makeDb();
  knowledgeSource(db, { minutes: 60 });

  scheduler.tick(db);
  const second = scheduler.tick(db);

  assert.equal(second.collect, 0);
  assert.equal(all(db, `SELECT * FROM jobs WHERE type = 'collect'`).length, 1);
});

test('a worker pass collects, curates and populates the stores', async () => {
  const db = makeDb();
  fetchPolicy.reset();
  knowledgeSource(db);

  const result = await workers.runOnce(db);

  assert.equal(result.queued.collect, 1);
  assert.equal(result.drained.failed, 0);
  assert.equal(result.pending, 0, 'the queue should be empty after a pass');
  assert.equal(get(db, `SELECT COUNT(*) AS n FROM kb_entries WHERE status = 'current'`).n, 1);
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM claims').n, 1);
});

test('a second worker pass does no work while nothing is due', async () => {
  const db = makeDb();
  fetchPolicy.reset();
  knowledgeSource(db, { minutes: 1440 });

  await workers.runOnce(db);
  const second = await workers.runOnce(db);

  assert.equal(second.queued.collect, 0);
  assert.equal(second.drained.done, 0);
});

test('a site-change draft is created once per detection, not once per pass', () => {
  const db = makeDb();
  const detectionId = trendsStore.record(db, {
    kind: 'pattern', domain: 'web_design', subject: 'core web vitals',
    summary: 'core web vitals lcp_ms moved -26% across 28 observations', score: 0.8, action: 'watch',
  });
  trendsStore.watch(db, detectionId, 'core web vitals');

  const first = workflows.fromTrends(db);
  const second = workflows.fromTrends(db);

  assert.equal(first.length, 1);
  assert.deepEqual(second, first, 'the same detection yields the same draft id');
  assert.equal(all(db, `SELECT * FROM workflow_drafts WHERE kind = 'site_change'`).length, 1);
  assert.equal(get(db, 'SELECT ref_id FROM workflow_drafts').ref_id, detectionId);
});

test('approving a draft records both an audit row and an annotation', () => {
  const db = makeDb();
  const draftId = workflows.draft(db, { kind: 'recommended_action', title: 'Do the thing', body: 'because' });

  workflows.approve(db, draftId, { principal: reviewer, note: 'looks right' });

  const annotation = get(db, `SELECT * FROM annotations WHERE object_id = ? AND kind = 'approval'`, draftId);
  assert.match(annotation.note, /approved: looks right/);
  assert.equal(annotation.actor, reviewer.id);
  assert.equal(get(db, `SELECT actor FROM promotion_audit WHERE object_id = ? AND to_state = 'approved'`, draftId).actor, reviewer.id);
});

test('a reviewer rationale is attached to the entry it was about', () => {
  const db = makeDb();
  const { addSource, addArtifact } = require('./helpers');
  const curationWorker = require('../src/staging/curationWorker');
  const review = require('../src/staging/review');

  const sourceId = addSource(db, { kind: 'public_web', collector: 'scraper', trust: 0.3 });
  addArtifact(db, sourceId, {
    title: 'Local pack citation audit', domain: 'local_business',
    text: 'Audit the Google Business Profile category and NAP citation consistency before touching local pack ranking.',
  });
  curationWorker.run(db);
  const item = get(db, `SELECT id FROM review_queue WHERE state = 'open'`);

  const result = review.decide(db, item.id, {
    principal: reviewer, decision: 'accepted_with_detail',
    detail: 'Service-area businesses only.', rationale: 'Matches our own observations.',
  });

  const onEntry = get(db, `SELECT * FROM annotations WHERE object_type = 'kb_entry' AND object_id = ?`, result.kbEntryId);
  assert.match(onEntry.note, /Matches our own observations/);
  assert.match(onEntry.note, /Service-area businesses only/);
  assert.equal(onEntry.kind, 'rationale');
  assert.ok(get(db, `SELECT * FROM annotations WHERE object_type = 'review' AND object_id = ?`, item.id));
});

test('setting a schedule clears the next run so the source is picked up immediately', () => {
  const db = makeDb();
  const sourceId = knowledgeSource(db, { minutes: 1440, nextRunAt: new Date(Date.now() + 86400000).toISOString() });

  scheduler.setSchedule(db, sourceId, 30);

  const source = get(db, 'SELECT schedule_minutes, next_run_at FROM sources WHERE id = ?', sourceId);
  assert.equal(source.schedule_minutes, 30);
  assert.equal(source.next_run_at, null);
  assert.equal(scheduler.tick(db).collect, 1);
});
