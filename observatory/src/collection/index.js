'use strict';
const { all, get } = require('../db');
const { logger } = require('../core/log');

const log = logger('collection');

const COLLECTORS = {
  scraper: require('./scraper'),
  file_importer: require('./fileImporter'),
  api_connector: require('./apiConnectors'),
  client_indexer: require('./clientIndexer'),
  knowledge_import: require('./knowledgeImport'),
};

async function collectSource(db, sourceId, opts = {}) {
  const source = get(db, 'SELECT * FROM sources WHERE id = ?', sourceId);
  if (!source) throw new Error(`source not found: ${sourceId}`);
  if (!source.enabled) return { sourceId, skipped: 'disabled' };

  const collector = COLLECTORS[source.collector];
  if (!collector) throw new Error(`unknown collector "${source.collector}" on source ${sourceId}`);

  const result = await collector.collect(db, source, opts);
  log.info('collected', { source: source.id, collector: source.collector, items: result.items ?? 0, skipped: result.skipped });
  return { sourceId, ...result };
}

/** Runs every enabled source. One failing source is reported, not fatal — the rest still collect. */
async function collectAll(db, { kind = null, ...opts } = {}) {
  const sources = all(db, `SELECT id FROM sources WHERE enabled = 1 AND (? IS NULL OR kind = ?)`, kind, kind);
  const results = [];
  for (const { id } of sources) {
    try {
      results.push(await collectSource(db, id, opts));
    } catch (err) {
      log.error('collection failed', { source: id, error: err.message });
      results.push({ sourceId: id, error: err.message });
    }
  }
  return results;
}

module.exports = { collectSource, collectAll, COLLECTORS };
