'use strict';
const { count, all } = require('./db');
const { logger } = require('./core/log');
const collection = require('./collection');
const curationWorker = require('./staging/curationWorker');
const statusWorker = require('./staging/statusWorker');
const trendsWorker = require('./staging/trendsWorker');
const knowledgeGraph = require('./stores/knowledgeGraph');

const log = logger('pipeline');

/**
 * One full left-to-right pass of the map:
 *   collect → curate (dedupe/classify/route/promote or queue) → status → trends → graph.
 * Each stage is independently runnable; this is the convenience path used by the CLI and cron.
 */
async function runAll(db, { kind = null, skipCollection = false, ...opts } = {}) {
  const started = Date.now();
  const result = {};

  result.collection = skipCollection ? { skipped: true } : await collection.collectAll(db, { kind, ...opts });
  result.curation = curationWorker.run(db, opts);
  result.status = statusWorker.run(db, opts);
  result.trends = trendsWorker.run(db, opts);
  result.graph = knowledgeGraph.rebuild(db);
  result.tookMs = Date.now() - started;

  log.info('pipeline pass complete', {
    promoted: result.curation.promoted,
    queued: result.curation.queued,
    detections: result.trends.anomalies + result.trends.patterns + result.trends.correlations,
    ms: result.tookMs,
  });
  return result;
}

/** Live counts for every box on the map — what the dashboard renders. */
function overview(db) {
  const byKind = (table, column) => all(db, `SELECT ${column} AS key, COUNT(*) AS n FROM ${table} GROUP BY ${column}`);

  return {
    sources: {
      total: count(db, 'SELECT COUNT(*) FROM sources'),
      enabled: count(db, 'SELECT COUNT(*) FROM sources WHERE enabled = 1'),
      by_kind: byKind('sources', 'kind'),
    },
    collection: {
      runs: count(db, 'SELECT COUNT(*) FROM collection_runs'),
      failed: count(db, `SELECT COUNT(*) FROM collection_runs WHERE status = 'failed'`),
      cost_cents: count(db, 'SELECT COALESCE(SUM(cost_cents), 0) FROM collection_runs'),
      by_collector: byKind('collection_runs', 'collector'),
      health: all(db, `SELECT sh.source_id, s.name, sh.window_start, sh.ok_count, sh.fail_count, sh.cost_cents, sh.last_success
                       FROM source_health sh JOIN sources s ON s.id = sh.source_id
                       ORDER BY sh.window_start DESC LIMIT 20`),
    },
    staging: {
      artifacts: count(db, 'SELECT COUNT(*) FROM staging_artifacts'),
      artifacts_new: count(db, `SELECT COUNT(*) FROM staging_artifacts WHERE state = 'new'`),
      candidates: byKind('candidates', 'state'),
      review_open: count(db, `SELECT COUNT(*) FROM review_queue WHERE state = 'open'`),
      review_critical: count(db, `SELECT COUNT(*) FROM review_queue WHERE state = 'open' AND severity = 'critical'`),
      decisions: byKind('review_decisions', 'decision'),
    },
    stores: {
      kb_entries: count(db, `SELECT COUNT(*) FROM kb_entries WHERE status = 'current'`),
      kb_by_domain: all(db, `SELECT domain AS key, COUNT(*) AS n FROM kb_entries WHERE status = 'current' GROUP BY domain`),
      kb_by_status: byKind('kb_entries', 'status'),
      client_corpus: count(db, 'SELECT COUNT(*) FROM client_corpus'),
      clients: count(db, 'SELECT COUNT(*) FROM clients'),
      claims: count(db, 'SELECT COUNT(*) FROM claims'),
      citations: count(db, 'SELECT COUNT(*) FROM citations'),
      uncited_claims: count(db, 'SELECT COUNT(*) FROM claims c WHERE NOT EXISTS (SELECT 1 FROM citations ci WHERE ci.claim_id = c.id)'),
      market_activity: count(db, 'SELECT COUNT(*) FROM market_activity'),
      inquiries_open: count(db, `SELECT COUNT(*) FROM inquiries WHERE status IN ('open','watching','experiment')`),
      trend_detections: count(db, 'SELECT COUNT(*) FROM trend_detections'),
      watchlist: count(db, `SELECT COUNT(*) FROM trend_watchlist WHERE state = 'active'`),
    },
    outputs: {
      reasoning_runs: count(db, 'SELECT COUNT(*) FROM reasoning_runs'),
      unsupported_flagged: count(db, 'SELECT COALESCE(SUM(unsupported), 0) FROM reasoning_runs'),
      workflow_drafts: byKind('workflow_drafts', 'status'),
      annotations: count(db, 'SELECT COUNT(*) FROM annotations'),
      reports: count(db, 'SELECT COUNT(*) FROM reports'),
      briefs: count(db, 'SELECT COUNT(*) FROM opportunity_briefs'),
      graph_nodes: count(db, 'SELECT COUNT(*) FROM graph_nodes'),
      graph_edges: count(db, 'SELECT COUNT(*) FROM graph_edges'),
    },
    audit: {
      transitions: count(db, 'SELECT COUNT(*) FROM promotion_audit'),
      recent: all(db, 'SELECT * FROM promotion_audit ORDER BY created_at DESC LIMIT 15'),
    },
  };
}

module.exports = { runAll, overview };
