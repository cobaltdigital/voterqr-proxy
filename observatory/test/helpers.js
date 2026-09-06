'use strict';
const dbModule = require('../src/db');
const { id, now } = require('../src/core/util');

/** Fresh in-memory database per test: no fixtures on disk, no shared state between files. */
function makeDb() {
  return dbModule.openEphemeral();
}

function addClient(db, { clientId = 'acme', name = 'Acme Co', tier = 'growth' } = {}) {
  dbModule.run(db, 'INSERT INTO clients (id, name, tier, created_at) VALUES (?, ?, ?, ?)', clientId, name, tier, now());
  return clientId;
}

function addSource(db, {
  sourceId = id('src'), kind = 'internal_knowledge', name = 'Test source',
  collector = 'knowledge_import', trust = 0.85, config = {}, clientId = null, enabled = 1,
} = {}) {
  dbModule.run(db,
    `INSERT INTO sources (id, kind, name, collector, config_json, trust, rate_limit_per_min, enabled, client_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 30, ?, ?, ?)`,
    sourceId, kind, name, collector, JSON.stringify(config), trust, enabled, clientId, now());
  return sourceId;
}

/** Writes a staging artifact directly, skipping collection — most tests start from staging. */
function addArtifact(db, sourceId, {
  title, text = '', domain = null, kind = null, clientId = null,
  parser = 'knowledge.markdown', fetchedAt = now(), extra = {},
} = {}) {
  const artifactId = id('art');
  const payload = { title, text, ...(domain ? { domain } : {}), ...(kind ? { kind } : {}), ...(clientId ? { client_id: clientId } : {}), ...extra };
  dbModule.run(db,
    `INSERT INTO staging_artifacts (id, source_id, uri, media_type, content_hash, payload_json, parser, parser_version, fetched_at, state)
     VALUES (?, ?, ?, 'text/markdown', ?, ?, ?, '1.0.0', ?, 'new')`,
    artifactId, sourceId, `test://${artifactId}`, id('hash'), JSON.stringify(payload), parser, fetchedAt);
  return artifactId;
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

module.exports = { makeDb, addClient, addSource, addArtifact, daysAgo };
