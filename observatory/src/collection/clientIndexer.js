'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { json, now } = require('../core/util');
const { startRun, finishRun, writeArtifact } = require('./artifacts');
const { listFiles } = require('./fileImporter');

const PARSER_VERSION = '1.0.0';

/**
 * Client Indexer — meeting-corpus style indexing of client systems
 * (Pipedrive, email, Drive, meetings, Tallyfy, ActiveCollab tasks/forms/reports).
 *
 * Indexes references and summaries, not full raw bodies: the corpus stores a snippet plus a
 * source ref, and the raw payload stays in staging behind that ref. Access parameters travel
 * with each record so the row-level rules survive into the curated store.
 */

const SNIPPET_CHARS = 480;

/** First sentences up to the snippet budget — a cheap extractive summary, no model call. */
function summarise(text, budget = SNIPPET_CHARS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= budget) return clean;
  const cut = clean.slice(0, budget);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (lastStop > budget * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim() + '…';
}

function readRecords(config) {
  if (config.records) return config.records;
  const dir = config.dir;
  if (!dir || !fs.existsSync(dir)) return [];
  return listFiles(dir, true)
    .filter((f) => f.endsWith('.json'))
    .flatMap((file) => {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const records = Array.isArray(parsed) ? parsed : [parsed];
      return records.map((r) => ({ ...r, source_file: path.resolve(file) }));
    });
}

async function collect(db, source) {
  const config = json(source.config_json, {});
  const clientId = source.client_id || config.client_id;
  if (!clientId) throw new Error(`client indexer source ${source.id} has no client_id`);

  const runId = startRun(db, source, 'client_indexer');
  const started = Date.now();
  let items = 0;

  try {
    for (const record of readRecords(config)) {
      const body = record.body || record.text || record.notes || '';
      const { duplicate } = writeArtifact(db, {
        sourceId: source.id,
        runId,
        uri: record.source_ref || record.source_file || `client://${clientId}/${record.kind}/${record.id || record.title}`,
        mediaType: 'application/json',
        payload: {
          client_id: clientId,
          kind: record.kind || 'doc',            // meeting|email|task|doc|sales|icp|form|report
          title: record.title || `${record.kind || 'doc'} ${record.id || ''}`.trim(),
          summary: summarise(body),
          snippet: summarise(body),
          body,                                   // stays in staging; corpus keeps the snippet
          participants: record.participants || [],
          occurred_at: record.occurred_at || record.date || now(),
          system: record.system || config.system || 'unknown',
          source_ref: record.source_ref || record.source_file || null,
          graph_refs: record.graph_refs || [],
          access: record.access || config.access || { restricted_to: null },
        },
        parser: 'client.indexer',
        parserVersion: PARSER_VERSION,
      });
      if (!duplicate) items += 1;
    }
    finishRun(db, runId, { status: 'ok', items, latencyMs: Date.now() - started });
    return { runId, items };
  } catch (err) {
    finishRun(db, runId, { status: 'failed', items, latencyMs: Date.now() - started, error: err.message });
    throw err;
  }
}

module.exports = { collect, summarise, SNIPPET_CHARS };
