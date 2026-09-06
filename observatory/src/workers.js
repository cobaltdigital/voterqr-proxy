'use strict';
const { logger } = require('./core/log');
const jobs = require('./core/jobs');
const scheduler = require('./scheduler');
const collection = require('./collection');
const curationWorker = require('./staging/curationWorker');
const statusWorker = require('./staging/statusWorker');
const trendsWorker = require('./staging/trendsWorker');
const knowledgeGraph = require('./stores/knowledgeGraph');
const workflows = require('./reasoning/workflows');

const log = logger('workers');

/**
 * The worker side of the queue: one handler per job type, and a loop that drains what the
 * scheduler queued. Each handler is the same function the CLI calls directly, so there is one
 * implementation of every stage whether it runs inline, on a schedule, or from an HTTP call.
 */
const HANDLERS = {
  collect: (db, payload) => collection.collectSource(db, payload.sourceId, { force: payload.force }),
  curate: (db, payload) => curationWorker.run(db, payload),
  status: (db, payload) => statusWorker.run(db, payload),
  trends: async (db, payload) => {
    const summary = trendsWorker.run(db, payload);
    // Watched detections in site-facing domains become site-change records to fill in.
    summary.siteChangeDrafts = workflows.fromTrends(db).length;
    return summary;
  },
  graph: (db) => knowledgeGraph.rebuild(db),
};

/** One pass: schedule what is due, then drain the queue. */
async function runOnce(db, { schedule = true } = {}) {
  const queued = schedule ? scheduler.tick(db) : { collect: 0, downstream: 0, skipped: 0 };
  const drained = await jobs.drain(db, HANDLERS);
  return { queued, drained, pending: jobs.pending(db).length };
}

/**
 * Long-running loop for `observatory workers`. Returns a stop function; the interval is
 * unref'd so it never holds the process open on its own.
 */
function start(db, { intervalMs = 60000, onTick = null } = {}) {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await runOnce(db);
      if (result.drained.done || result.drained.failed) {
        log.info('worker pass', { done: result.drained.done, failed: result.drained.failed, pending: result.pending });
      }
      if (onTick) onTick(result);
    } catch (err) {
      log.error('worker pass failed', { error: err.message });
    } finally {
      running = false;
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  log.info(`workers started, every ${Math.round(intervalMs / 1000)}s`);

  return function stop() {
    stopped = true;
    clearInterval(timer);
    log.info('workers stopped');
  };
}

module.exports = { HANDLERS, runOnce, start };
