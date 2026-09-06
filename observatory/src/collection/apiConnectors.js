'use strict';
const { json, now, daysBetween } = require('../core/util');
const { logger } = require('../core/log');
const connectors = require('./connectors');
const marketActivity = require('../stores/marketActivity');
const { startRun, finishRun, writeArtifact } = require('./artifacts');
const { get } = require('../db');

const log = logger('api-connectors');

/**
 * API Connectors — scoped credentials, cost + freshness logs.
 *
 * Every vendor call goes through here so three things are always true:
 *   1. credentials are resolved from the environment and never stored in the database,
 *   2. cost is attributed to the source that incurred it,
 *   3. a source that is already fresh enough is skipped instead of re-billed.
 */

/** Freshness gate: has this source been collected inside the connector's freshness budget? */
function isFresh(db, source, connector) {
  const last = get(db,
    `SELECT finished_at FROM collection_runs WHERE source_id = ? AND status = 'ok' AND finished_at IS NOT NULL
     ORDER BY finished_at DESC LIMIT 1`, source.id);
  if (!last) return false;
  const budget = (json(source.config_json, {}).freshness_hours ?? connector.freshnessHours ?? 24) / 24;
  return daysBetween(last.finished_at, now()) < budget;
}

async function collect(db, source, { force = false } = {}) {
  const config = json(source.config_json, {});
  const connector = connectors.get(config.connector || source.name);

  if (!force && isFresh(db, source, connector)) {
    log.debug('skipped, still fresh', { source: source.id, connector: connector.name });
    return { skipped: 'fresh', runId: null, items: 0 };
  }

  const { values, missing } = connectors.resolveCredentials(connector);
  const optional = new Set(connector.optionalCredentials || []);
  const blocking = missing.filter((key) => !optional.has(key));
  if (blocking.length) {
    throw new Error(`connector ${connector.name} is missing credentials: ${blocking.join(', ')}`);
  }

  const runId = startRun(db, source, 'api_connector');
  const started = Date.now();
  let items = 0;

  try {
    const result = await connector.fetch({ source, config, credentials: values, since: config.since || null });
    const records = result.records || [];

    for (const record of records) {
      const { artifactId, duplicate } = writeArtifact(db, {
        sourceId: source.id,
        runId,
        uri: `connector://${connector.name}/${record.key || record.subject}`,
        mediaType: 'application/json',
        payload: { ...record, connector: connector.name, vendor: connector.vendor },
        parser: `connector.${connector.name}`,
        parserVersion: connector.version || '1.0.0',
        costCents: connector.costCentsPerCall || 0,
        fetchedAt: record.observed_at || now(),
      });
      if (duplicate) continue;
      items += 1;

      // Signals are watched market activity: recorded neutrally, before any interpretation.
      if (record.kind === 'signal') {
        marketActivity.append(db, {
          observedAt: record.observed_at || now(),
          channel: record.channel || 'platform',
          subject: record.subject,
          signal: record.signal,
          value: record.value,
          unit: record.unit,
          sourceId: source.id,
          artifactId,
          meta: { connector: connector.name, domain: record.domain, ...(record.meta || {}) },
        });
      }
    }

    const costCents = result.costCents ?? (connector.costCentsPerCall || 0) * Math.max(1, records.length);
    finishRun(db, runId, { status: 'ok', items, costCents, latencyMs: Date.now() - started });
    return { runId, items, costCents, connector: connector.name };
  } catch (err) {
    finishRun(db, runId, { status: 'failed', items, latencyMs: Date.now() - started, error: err.message });
    throw err;
  }
}

module.exports = { collect, isFresh };
